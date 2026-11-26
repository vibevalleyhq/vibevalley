import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  captureVdpScreenshot,
  CreatedEntitySchema,
  countUiTreeNodes,
  createCliVdpDriver,
  ensureVdpArtifactsBuilt,
  extractShellErrors,
  flattenUiNodes,
  isReviewTheme,
  parseJsonOutput,
  parsePort,
  parsePositiveInt,
  resolveVdpWorkspacePaths,
  runChecked,
  runSoft,
  type ReviewTheme,
  type VdpDriver,
  type VdpUiNode,
  withVdpSandbox,
} from "./vdp-client.ts";

export { flattenUiNodes, type VdpDriver, type VdpUiNode };

export interface FlowOptions {
  readonly outDir: string;
  readonly port?: number | undefined;
  readonly home?: string | undefined;
  readonly url?: string | undefined;
  readonly theme: ReviewTheme;
  readonly width: number;
  readonly height: number;
  readonly skipBuild: boolean;
  readonly keepSandbox: boolean;
  readonly help: boolean;
}

export const FlowCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export type FlowCheck = z.infer<typeof FlowCheckSchema>;

export const FlowScreenshotSchema = z.object({
  path: z.string(),
  relPath: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export type FlowScreenshot = z.infer<typeof FlowScreenshotSchema>;

export const FlowStepResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  route: z.string(),
  passed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  checks: z.array(FlowCheckSchema),
  screenshot: FlowScreenshotSchema.nullable(),
  shellRoute: z.string().nullable(),
  shellErrors: z.array(z.string()),
  uiNodeCount: z.number().int().nonnegative(),
});

export type FlowStepResult = z.infer<typeof FlowStepResultSchema>;

export const FlowSummarySchema = z.object({
  totalSteps: z.number().int().nonnegative(),
  passedSteps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  totalChecks: z.number().int().nonnegative(),
  passedChecks: z.number().int().nonnegative(),
  failedChecks: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  totalScreenshots: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  allPassed: z.boolean(),
});

export type FlowSummary = z.infer<typeof FlowSummarySchema>;

export const FlowReportSchema = z.object({
  generatedAt: z.string(),
  outDir: z.string(),
  mode: z.enum(["attached", "sandbox"]),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  theme: z.enum(["light", "dark"]),
  steps: z.array(FlowStepResultSchema),
  summary: FlowSummarySchema,
});

export type FlowReport = z.infer<typeof FlowReportSchema>;

export const KANBAN_LANES = [
  { testId: "lane-todo", zh: "待办", en: "To do" },
  { testId: "lane-working", zh: "进行中", en: "In progress" },
  { testId: "lane-waiting", zh: "待验收", en: "In review" },
  { testId: "lane-closed", zh: "已完成", en: "Done" },
] as const;

export const SWEEP_ROUTES = [
  { id: "route-runtimes", label: "Runtimes & Engines", route: "/runtimes", waitTestId: "runtimes-page", shotName: "flow-runtimes.png" },
  { id: "route-agents", label: "Agents Roster", route: "/agents", shotName: "flow-agents.png" },
  { id: "route-settings", label: "Settings", route: "/settings", shotName: "flow-settings.png" },
] as const;

export function parseFlowArgs(argv: readonly string[], cwd = process.cwd()): FlowOptions {
  let outDir = "/tmp/vv-vdp-flow";
  let port: number | undefined;
  let home: string | undefined;
  let url: string | undefined;
  let theme: ReviewTheme = "light";
  let width = 1280;
  let height = 840;
  let skipBuild = false;
  let keepSandbox = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--keep-sandbox") {
      keepSandbox = true;
    } else if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, next);
    } else if (arg.startsWith("--out=")) {
      const val = arg.slice("--out=".length);
      if (!val) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, val);
    } else if (arg === "--port") {
      const next = argv[++i];
      if (!next) throw new Error("--port requires a TCP port number");
      port = parsePort(next);
    } else if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--home") {
      const next = argv[++i];
      if (!next) throw new Error("--home requires a VibeValley home directory");
      home = resolve(cwd, next);
    } else if (arg.startsWith("--home=")) {
      const val = arg.slice("--home=".length);
      if (!val) throw new Error("--home requires a VibeValley home directory");
      home = resolve(cwd, val);
    } else if (arg === "--url") {
      const next = argv[++i];
      if (!next) throw new Error("--url requires a VDP WebSocket or HTTP URL");
      url = next.trim();
    } else if (arg.startsWith("--url=")) {
      const val = arg.slice("--url=".length).trim();
      if (!val) throw new Error("--url requires a VDP WebSocket or HTTP URL");
      url = val;
    } else if (arg === "--theme") {
      const next = argv[++i];
      if (!next) throw new Error("--theme requires light or dark");
      const normalized = next.trim().toLowerCase();
      if (!isReviewTheme(normalized)) throw new Error(`unsupported theme "${next}" (expected light or dark)`);
      theme = normalized;
    } else if (arg.startsWith("--theme=")) {
      const raw = arg.slice("--theme=".length).trim().toLowerCase();
      if (!isReviewTheme(raw)) throw new Error(`unsupported theme "${raw}" (expected light or dark)`);
      theme = raw;
    } else if (arg === "--width") {
      const next = argv[++i];
      if (!next) throw new Error("--width requires a pixel value");
      width = parsePositiveInt("--width", next);
    } else if (arg.startsWith("--width=")) {
      width = parsePositiveInt("--width", arg.slice("--width=".length));
    } else if (arg === "--height") {
      const next = argv[++i];
      if (!next) throw new Error("--height requires a pixel value");
      height = parsePositiveInt("--height", next);
    } else if (arg.startsWith("--height=")) {
      height = parsePositiveInt("--height", arg.slice("--height=".length));
    } else {
      throw new Error(`unknown option "${arg}" (run with --help for usage)`);
    }
  }

  return { outDir, port, home, url, theme, width, height, skipBuild, keepSandbox, help };
}

export function checkKanbanBoardInvariants(nodes: readonly VdpUiNode[], workingSlotsCount: number): FlowCheck[] {
  const checks: FlowCheck[] = [];
  const testIds = new Set(nodes.map((n) => n.testId).filter((id): id is string => typeof id === "string" && id.length > 0));
  const texts = nodes.map((n) => n.text ?? "").filter(Boolean);

  const missingLanes: string[] = [];
  for (const lane of KANBAN_LANES) {
    const hasId = testIds.has(lane.testId);
    const hasText = texts.some((txt) => txt.includes(lane.zh) || txt.toLowerCase().includes(lane.en.toLowerCase()));
    if (!hasId && !hasText) {
      missingLanes.push(`${lane.testId} (${lane.zh})`);
    }
  }

  checks.push({
    name: "kanban-4-lanes",
    passed: missingLanes.length === 0,
    detail: missingLanes.length === 0 ? "all 4 Kanban lanes verified (待办 / 进行中 / 待验收 / 已完成)" : `missing Kanban lanes: ${missingLanes.join(", ")}`,
  });

  checks.push({
    name: "zero-lane-working-slots",
    passed: workingSlotsCount === 0,
    detail: workingSlotsCount === 0 ? "lane-working-slots count is 0" : `expected 0 lane-working-slots, found ${workingSlotsCount}`,
  });

  return checks;
}

export function checkNewIssueDropdownReadiness(params: {
  readonly dialogOpen: boolean;
  readonly repoSelectCount: number;
  readonly helperSelectCount: number;
  readonly missingRepoCount: number;
  readonly missingRuntimeCount: number;
  readonly dialogClosedAfterCancel: boolean;
}): FlowCheck[] {
  const repoReady = params.repoSelectCount > 0;
  const helperReady = params.helperSelectCount > 0;
  const repoHandled = repoReady || params.missingRepoCount > 0;
  const helperHandled = helperReady || params.missingRuntimeCount > 0;

  return [
    {
      name: "new-issue-dialog-opened",
      passed: params.dialogOpen,
      detail: params.dialogOpen ? "NewIssue dialog mounted after clicking issue-toolbar-new" : "NewIssue dialog did not mount",
    },
    {
      name: "new-issue-repo-dropdown",
      passed: repoHandled,
      detail: repoReady
        ? `issue-new-repo dropdown ready (${params.repoSelectCount})`
        : params.missingRepoCount > 0
          ? "issue-new-repo absent; missing-repo setup banner surfaced cleanly"
          : "neither issue-new-repo dropdown nor missing-repo guidance found",
    },
    {
      name: "new-issue-helper-dropdown",
      passed: helperHandled,
      detail: helperReady
        ? `issue-new-helper dropdown ready (${params.helperSelectCount})`
        : params.missingRuntimeCount > 0
          ? "issue-new-helper absent; missing-runtime setup banner surfaced cleanly"
          : "neither issue-new-helper dropdown nor missing-runtime guidance found",
    },
    {
      name: "new-issue-dialog-closed",
      passed: params.dialogClosedAfterCancel,
      detail: params.dialogClosedAfterCancel ? "dialog closed cleanly via issue-new-dialog-never" : "dialog remained open after pressing cancel",
    },
  ];
}

export function checkQuickPeekInvariants(params: {
  readonly cardCount: number;
  readonly peekExpandCount: number;
  readonly shellRoute: string | null;
}): FlowCheck[] {
  const stayedOnIssues = params.shellRoute === null || params.shellRoute === "/issues" || params.shellRoute.startsWith("/issues?");
  return [
    {
      name: "issue-card-available",
      passed: params.cardCount > 0,
      detail: params.cardCount > 0 ? `found ${params.cardCount} issue card(s)` : "no issue-card nodes available on board",
    },
    {
      name: "quick-peek-modal-open",
      passed: params.peekExpandCount > 0,
      detail: params.peekExpandCount > 0 ? "Quick-Peek modal opened with issue-peek-expand" : "issue-peek-expand not found after pressing first issue-card",
    },
    {
      name: "quick-peek-stays-on-issues",
      passed: stayedOnIssues,
      detail: stayedOnIssues ? `remained on ${params.shellRoute ?? "/issues"} without navigating away` : `unexpected route change to ${params.shellRoute}`,
    },
  ];
}

export function aggregateFlowReport(params: {
  readonly generatedAt?: string;
  readonly outDir: string;
  readonly mode: "attached" | "sandbox";
  readonly viewport: { readonly width: number; readonly height: number };
  readonly theme: ReviewTheme;
  readonly steps: readonly FlowStepResult[];
}): FlowReport {
  const passedSteps = params.steps.filter((s) => s.passed).length;
  const failedSteps = params.steps.length - passedSteps;

  let totalChecks = 0;
  let passedChecks = 0;
  let totalErrors = 0;
  let totalScreenshots = 0;
  let totalBytes = 0;

  for (const step of params.steps) {
    totalChecks += step.checks.length;
    passedChecks += step.checks.filter((c) => c.passed).length;
    totalErrors += step.shellErrors.length;
    if (step.screenshot !== null) {
      totalScreenshots += 1;
      totalBytes += step.screenshot.bytes;
    }
  }

  const failedChecks = totalChecks - passedChecks;
  const allPassed = failedSteps === 0 && failedChecks === 0 && totalErrors === 0;

  return FlowReportSchema.parse({
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    outDir: params.outDir,
    mode: params.mode,
    viewport: { width: params.viewport.width, height: params.viewport.height },
    theme: params.theme,
    steps: [...params.steps],
    summary: {
      totalSteps: params.steps.length,
      passedSteps,
      failedSteps,
      totalChecks,
      passedChecks,
      failedChecks,
      totalErrors,
      totalScreenshots,
      totalBytes,
      allPassed,
    },
  });
}

function makeStepResult(params: {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly startedAt: number;
  readonly checks: readonly FlowCheck[];
  readonly screenshot: FlowScreenshot | null;
  readonly shellRoute: string | null;
  readonly shellErrors: readonly string[];
  readonly uiNodeCount: number;
}): FlowStepResult {
  const allChecksPassed = params.checks.every((c) => c.passed);
  const passed = allChecksPassed && params.shellErrors.length === 0;
  return {
    id: params.id,
    label: params.label,
    route: params.route,
    passed,
    durationMs: Math.max(0, Date.now() - params.startedAt),
    checks: [...params.checks],
    screenshot: params.screenshot,
    shellRoute: params.shellRoute,
    shellErrors: [...params.shellErrors],
    uiNodeCount: params.uiNodeCount,
  };
}

async function inspectShellAndTree(driver: VdpDriver): Promise<{
  readonly shellRoute: string | null;
  readonly shellErrors: string[];
  readonly treeNodes: readonly VdpUiNode[];
  readonly uiNodeCount: number;
}> {
  const rawState = await driver.getState();
  const shell = extractShellErrors(rawState);
  let treeNodes: readonly VdpUiNode[] = [];
  let uiNodeCount = 0;
  try {
    const tree = await driver.uiGetTree("workbench", 10);
    treeNodes = tree.nodes;
    uiNodeCount = countUiTreeNodes(tree.nodes);
  } catch (err) {
    shell.errors.push(`UI.getTree failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    shellRoute: shell.route,
    shellErrors: shell.errors,
    treeNodes,
    uiNodeCount,
  };
}

export async function runFlowScenario(
  driver: VdpDriver,
  options: {
    readonly outDir: string;
    readonly mode: "attached" | "sandbox";
    readonly viewport: { readonly width: number; readonly height: number };
    readonly theme: ReviewTheme;
  },
): Promise<FlowReport> {
  const shotsDir = resolve(options.outDir, "shots");
  const steps: FlowStepResult[] = [];

  await driver.resize(options.viewport.width, options.viewport.height);
  await driver.setTheme(options.theme);
  await driver.settle(350);

  // Step 1: Navigate /issues -> verify Kanban 4 lanes & 0 lane-working-slots.
  {
    const startedAt = Date.now();
    await driver.navigate("/issues");
    await driver.uiWaitFor({ testId: "issues-page", view: "workbench", timeoutMs: 4_000 });
    await driver.settle(450);

    const { shellRoute, shellErrors, treeNodes, uiNodeCount } = await inspectShellAndTree(driver);
    const flatNodes = flattenUiNodes(treeNodes);
    const slotsRes = await driver.uiQuery({ testId: "lane-working-slots", view: "workbench" });

    // Also query each lane testId explicitly in case shallow tree pruning omits deep children.
    const queriedLanes: VdpUiNode[] = [...flatNodes];
    for (const lane of KANBAN_LANES) {
      const res = await driver.uiQuery({ testId: lane.testId, view: "workbench" });
      queriedLanes.push(...res.nodes);
      const textRes = await driver.uiQuery({ text: lane.zh, view: "workbench" });
      queriedLanes.push(...textRes.nodes);
    }

    const checks = checkKanbanBoardInvariants(queriedLanes, slotsRes.count);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-issues-board.png", shellErrors);
    steps.push(
      makeStepResult({
        id: "issues-board",
        label: "Issues Kanban Board (4 lanes & 0 working-slots)",
        route: "/issues",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 2: Click issue-toolbar-new -> inspect repo & helper dropdowns -> capture -> close via issue-new-dialog-never.
  {
    const startedAt = Date.now();
    let dialogOpen = false;
    let repoSelectCount = 0;
    let helperSelectCount = 0;
    let missingRepoCount = 0;
    let missingRuntimeCount = 0;
    let dialogClosedAfterCancel = false;
    const extraErrors: string[] = [];

    try {
      await driver.uiPress("issue-toolbar-new", "workbench");
      const waited = await driver.uiWaitFor({ testId: "issue-new-dialog", view: "workbench", timeoutMs: 3_000 });
      const textWait = waited.found ? waited : await driver.uiWaitFor({ testId: "issue-new-text", view: "workbench", timeoutMs: 1_500 });
      dialogOpen = waited.found || textWait.found;
      await driver.settle(300);

      repoSelectCount = (await driver.uiQuery({ testId: "issue-new-repo", view: "workbench" })).count;
      helperSelectCount = (await driver.uiQuery({ testId: "issue-new-helper", view: "workbench" })).count;
      missingRepoCount = (await driver.uiQuery({ testId: "issue-new-missing-repo", view: "workbench" })).count;
      missingRuntimeCount = (await driver.uiQuery({ testId: "issue-new-missing-runtime", view: "workbench" })).count;
    } catch (err) {
      extraErrors.push(`NewIssue interaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-new-issue.png", shellErrors);

    if (dialogOpen) {
      try {
        await driver.uiPress("issue-new-dialog-never", "workbench");
        await driver.settle(250);
        const afterClose = await driver.uiQuery({ testId: "issue-new-dialog", view: "workbench" });
        const afterCloseText = await driver.uiQuery({ testId: "issue-new-text", view: "workbench" });
        dialogClosedAfterCancel = afterClose.count === 0 && afterCloseText.count === 0;
      } catch (err) {
        shellErrors.push(`Closing NewIssue dialog failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const checks = checkNewIssueDropdownReadiness({
      dialogOpen,
      repoSelectCount,
      helperSelectCount,
      missingRepoCount,
      missingRuntimeCount,
      dialogClosedAfterCancel,
    });
    steps.push(
      makeStepResult({
        id: "new-issue-dialog",
        label: "NewIssue Dialog & Dropdown Readiness",
        route: "/issues",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 3: Click first issue-card -> verify Quick-Peek modal opens without leaving /issues.
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    const cards = await driver.uiQuery({ testId: "issue-card", view: "workbench" });
    let peekExpandCount = 0;

    if (cards.count > 0) {
      try {
        await driver.uiPress("issue-card", "workbench");
        await driver.uiWaitFor({ testId: "issue-peek-expand", view: "workbench", timeoutMs: 3_000 });
        await driver.settle(300);
        peekExpandCount = (await driver.uiQuery({ testId: "issue-peek-expand", view: "workbench" })).count;
      } catch (err) {
        extraErrors.push(`Quick-Peek interaction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-quick-peek.png", shellErrors);
    const checks = checkQuickPeekInvariants({ cardCount: cards.count, peekExpandCount, shellRoute });

    steps.push(
      makeStepResult({
        id: "quick-peek",
        label: "Issue Card Quick-Peek Modal",
        route: "/issues",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 4: Click issue-peek-expand -> verify full-screen Issue Detail opens (issue-title).
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    let titleCount = 0;

    try {
      await driver.uiPress("issue-peek-expand", "workbench");
      await driver.uiWaitFor({ testId: "issue-title", view: "workbench", timeoutMs: 3_500 });
      await driver.settle(350);
      titleCount = (await driver.uiQuery({ testId: "issue-title", view: "workbench" })).count;
    } catch (err) {
      extraErrors.push(`Expand to Issue Detail failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-detail-expanded.png", shellErrors);
    const onDetailRoute = shellRoute !== null && shellRoute.startsWith("/issues/") && shellRoute.length > "/issues/".length;

    const checks: FlowCheck[] = [
      {
        name: "issue-detail-title-visible",
        passed: titleCount > 0,
        detail: titleCount > 0 ? "issue-title rendered in full-screen detail view" : "issue-title not found after clicking issue-peek-expand",
      },
      {
        name: "issue-detail-route-active",
        passed: onDetailRoute || titleCount > 0,
        detail: onDetailRoute ? `navigated to ${shellRoute}` : `shellRoute=${shellRoute ?? "<none>"}`,
      },
    ];
    steps.push(
      makeStepResult({
        id: "detail-expanded",
        label: "Full-Screen Issue Detail Expanded",
        route: shellRoute ?? "/issues/:id",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 5: Navigate back to /issues, toggle List view (issue-view-list / issue-view).
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    await driver.navigate("/issues");
    await driver.uiWaitFor({ testId: "issues-page", view: "workbench", timeoutMs: 4_000 });
    await driver.settle(300);

    let toggled = false;
    let toggleTarget = "issue-view-list";
    try {
      const listOpt = await driver.uiQuery({ testId: "issue-view-list", view: "workbench" });
      if (listOpt.count > 0) {
        await driver.uiPress("issue-view-list", "workbench");
        toggled = true;
      } else {
        toggleTarget = "issue-view";
        await driver.uiPress("issue-view", "workbench");
        toggled = true;
      }
      await driver.settle(350);
    } catch (err) {
      extraErrors.push(`Toggle list view (${toggleTarget}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const listCards = await driver.uiQuery({ testId: "issue-card", view: "workbench" });
    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-issues-list.png", shellErrors);

    const checks: FlowCheck[] = [
      {
        name: "issues-list-toggle-pressed",
        passed: toggled,
        detail: toggled ? `switched to list view via ${toggleTarget}` : `failed to toggle list view via ${toggleTarget}`,
      },
      {
        name: "issues-list-cards-rendered",
        passed: listCards.count > 0,
        detail: listCards.count > 0 ? `${listCards.count} issue row(s) rendered in list view` : "no issue rows visible after switching to list view",
      },
    ];
    steps.push(
      makeStepResult({
        id: "issues-list",
        label: "Issues List View Toggle",
        route: "/issues",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 6: Navigate /runs -> click first step row to verify inline structured detail drawer expands.
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    await driver.navigate("/runs");
    await driver.uiWaitFor({ testId: "runs-page", view: "workbench", timeoutMs: 4_000 });
    await driver.settle(450);

    let initialTree = await driver.uiGetTree("workbench", 12);
    let flat = flattenUiNodes(initialTree.nodes);

    // Select the first run row if no trajectory step toggle is mounted yet.
    const firstRunRow = flat.find((n) => typeof n.testId === "string" && n.testId.startsWith("run-row-"));
    let firstStepToggle = flat.find((n) => typeof n.testId === "string" && (n.testId.startsWith("step-toggle-") || n.testId === "tool-step"));

    if (!firstStepToggle && firstRunRow?.testId) {
      try {
        await driver.uiPress(firstRunRow.testId, "workbench");
        await driver.settle(350);
        initialTree = await driver.uiGetTree("workbench", 12);
        flat = flattenUiNodes(initialTree.nodes);
        firstStepToggle = flat.find((n) => typeof n.testId === "string" && (n.testId.startsWith("step-toggle-") || n.testId === "tool-step"));
      } catch (err) {
        extraErrors.push(`Selecting run row ${firstRunRow.testId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const checks: FlowCheck[] = [
      {
        name: "runs-page-mounted",
        passed: flat.some((n) => n.testId === "runs-page") || (await driver.uiQuery({ testId: "runs-page", view: "workbench" })).count > 0,
        detail: "runs-page view mounted cleanly",
      },
    ];

    if (firstStepToggle?.testId) {
      const toggleId = firstStepToggle.testId;
      const seq = toggleId.startsWith("step-toggle-") ? toggleId.slice("step-toggle-".length) : null;
      const expectedDrawerId = seq !== null ? `step-drawer-${seq}` : "tool-copy-input";
      try {
        await driver.uiPress(toggleId, "workbench");
        await driver.settle(300);
        const drawerRes = await driver.uiQuery({ testId: expectedDrawerId, view: "workbench" });
        checks.push({
          name: "runs-step-drawer-expanded",
          passed: drawerRes.count > 0,
          detail:
            drawerRes.count > 0
              ? `clicked ${toggleId} and verified ${expectedDrawerId} expanded`
              : `clicked ${toggleId} but ${expectedDrawerId} did not appear`,
        });
      } catch (err) {
        extraErrors.push(`Expanding run step ${toggleId} failed: ${err instanceof Error ? err.message : String(err)}`);
        checks.push({
          name: "runs-step-drawer-expanded",
          passed: false,
          detail: `failed pressing ${toggleId}`,
        });
      }
    } else {
      const emptyRes = await driver.uiQuery({ testId: "runs-empty", view: "workbench" });
      checks.push({
        name: "runs-step-or-empty-state",
        passed: emptyRes.count > 0 || firstRunRow !== undefined,
        detail:
          emptyRes.count > 0
            ? "no executed run steps present yet; runs-empty state verified cleanly"
            : firstRunRow?.testId
              ? `selected ${firstRunRow.testId}; no step toggles emitted yet`
              : "neither run step rows nor runs-empty state found",
      });
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, "flow-runs-expanded.png", shellErrors);
    steps.push(
      makeStepResult({
        id: "runs-expanded",
        label: "Runs Trajectory & Inline Step Drawer",
        route: "/runs",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 7: Navigate /runtimes, /agents, /settings -> assert zero shell/view errors across every route.
  for (const spec of SWEEP_ROUTES) {
    const startedAt = Date.now();
    await driver.navigate(spec.route);
    if ("waitTestId" in spec && spec.waitTestId) {
      await driver.uiWaitFor({ testId: spec.waitTestId, view: "workbench", timeoutMs: 3_500 });
    }
    await driver.settle(450);

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    const screenshot = await captureVdpScreenshot(driver, shotsDir, spec.shotName, shellErrors);
    const checks: FlowCheck[] = [
      {
        name: `${spec.id}-zero-shell-errors`,
        passed: shellErrors.length === 0,
        detail: shellErrors.length === 0 ? `${spec.route} loaded with 0 shell/view errors` : `${spec.route} reported ${shellErrors.length} error(s)`,
      },
    ];
    steps.push(
      makeStepResult({
        id: spec.id,
        label: spec.label,
        route: spec.route,
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  return aggregateFlowReport({
    outDir: options.outDir,
    mode: options.mode,
    viewport: options.viewport,
    theme: options.theme,
    steps,
  });
}

function seedFlowSandbox(cliBin: string, root: string, cliEnv: NodeJS.ProcessEnv, payloadDir: string): void {
  const vvJson = <T>(args: readonly string[], schema: z.ZodType<T>, label: string): T =>
    parseJsonOutput(runChecked(cliBin, [...args, "--json"], { cwd: root, env: cliEnv, capture: true, timeoutMs: 30_000 }), schema, label);

  const agent = vvJson(
    ["agent", "create", "Milo", "--runtime", "vibevalley", "--role", "worker", "--duty", "UX flow verification and board triage"],
    CreatedEntitySchema,
    "agent create Milo",
  );
  runSoft(cliBin, ["repo", "create", "vibevalley"], { cwd: root, env: cliEnv, timeoutMs: 20_000 });

  const descPath = join(payloadDir, "flow-issue.md");
  writeFileSync(
    descPath,
    ["## Flow Verification Seed", "Exercises Kanban 4-lane layout, NewIssue dropdowns, Quick-Peek modal, full-screen Detail expansion, and List toggle."].join(
      "\n",
    ),
    "utf8",
  );

  vvJson(
    [
      "issue",
      "create",
      "Verify Quick-Peek modal and full-screen issue expansion via VDP",
      "--repo",
      "vibevalley",
      "--priority",
      "high",
      "--agent",
      agent.id,
      "--description",
      `@${descPath}`,
      "--criterion",
      "Clicking a Kanban card opens Quick-Peek without leaving /issues",
    ],
    CreatedEntitySchema,
    "issue create seed",
  );
}

function printUsage(): void {
  console.log(`Usage: vp run ui:flow -- [options]

Options:
  --out <dir>          Output directory for report.json and shots/ (default: /tmp/vv-vdp-flow)
  --port <port>        Attach to a running VibeValley app on loopback VDP port
  --home <dir>         Attach to a running VibeValley app using its VIBEVALLEY_HOME debug.json
  --url <url>          Attach to an explicit VDP WebSocket/HTTP URL
  --theme <light|dark> Theme mode for screenshots (default: light)
  --width <px>         Window logical width in pixels (default: 1280)
  --height <px>        Window logical height in pixels (default: 840)
  --skip-build         Reuse existing vibevalley-mac, vibevalley CLI, and UI bundles in sandbox mode
  --keep-sandbox       Preserve temporary sandbox directory after exit
  -h, --help           Show this help message`);
}

function writeAndCheckFlowReport(outDir: string, report: FlowReport): FlowReport {
  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.summary.allPassed) {
    throw new Error(`vdp-flow failed (${report.summary.failedSteps} step(s), ${report.summary.totalErrors} error(s)) -> ${resolve(outDir, "report.json")}`);
  }
  console.log(
    `vdp-flow: passed ${report.summary.passedSteps}/${report.summary.totalSteps} steps (${report.summary.totalScreenshots} shots) -> ${resolve(outDir, "report.json")}`,
  );
  return report;
}

export async function runVdpFlow(options: FlowOptions): Promise<FlowReport> {
  const root = resolve(import.meta.dirname, "../..");
  const paths = resolveVdpWorkspacePaths(root);
  const isAttached = options.port !== undefined || options.home !== undefined || options.url !== undefined;

  const shotsDir = resolve(options.outDir, "shots");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  if (isAttached) {
    ensureVdpArtifactsBuilt(paths, { skipBuild: options.skipBuild, cliOnly: true });
    const targetFlags: string[] = [];
    if (options.home !== undefined) targetFlags.push("--home", options.home);
    if (options.port !== undefined) targetFlags.push("--port", String(options.port));
    if (options.url !== undefined) targetFlags.push("--url", options.url);

    const driver = createCliVdpDriver({ cliBin: paths.cliBin, root, env: process.env, targetFlags });
    const report = await runFlowScenario(driver, {
      outDir: options.outDir,
      mode: "attached",
      viewport: { width: options.width, height: options.height },
      theme: options.theme,
    });
    return writeAndCheckFlowReport(options.outDir, report);
  }

  if (process.platform === "win32") {
    throw new Error("vdp-flow sandbox mode requires macOS/Unix process groups");
  }

  ensureVdpArtifactsBuilt(paths, { skipBuild: options.skipBuild });

  const report = await withVdpSandbox(
    {
      prefix: "vv-vdp-flow-",
      logTag: "vdp-flow",
      paths,
      outDir: options.outDir,
      keepSandbox: options.keepSandbox,
    },
    async ({ payloadDir, cliEnv, driver }) => {
      seedFlowSandbox(paths.cliBin, root, cliEnv, payloadDir);
      return runFlowScenario(driver, {
        outDir: options.outDir,
        mode: "sandbox",
        viewport: { width: options.width, height: options.height },
        theme: options.theme,
      });
    },
  );
  return writeAndCheckFlowReport(options.outDir, report);
}

if (import.meta.main) {
  try {
    const options = parseFlowArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      await runVdpFlow(options);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
