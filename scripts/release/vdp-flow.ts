import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { countUiTreeNodes, extractShellErrors, isReviewTheme, type ReviewTheme } from "./vdp-review.ts";

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

export interface VdpUiNode {
  readonly testId?: string | null | undefined;
  readonly role?: string | null | undefined;
  readonly text?: string | null | undefined;
  readonly route?: string | null | undefined;
  readonly pressable?: boolean | undefined;
  readonly children?: readonly VdpUiNode[] | null | undefined;
}

export interface VdpUiQueryResult {
  readonly view: string;
  readonly route?: string | null | undefined;
  readonly count: number;
  readonly nodes: readonly VdpUiNode[];
}

export interface VdpUiPressResult {
  readonly pressed: boolean;
  readonly view?: string | undefined;
  readonly testId?: string | undefined;
}

export interface VdpUiWaitForResult {
  readonly found: boolean;
  readonly node?: VdpUiNode | null | undefined;
}

export interface VdpUiTreeResult {
  readonly view: string;
  readonly route?: string | null | undefined;
  readonly nodes: readonly VdpUiNode[];
}

export interface VdpScreenshotInfo {
  readonly path: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface VdpDriver {
  navigate(route: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  setTheme(theme: ReviewTheme): Promise<void>;
  getState(): Promise<unknown>;
  uiQuery(params: { readonly testId?: string; readonly text?: string; readonly role?: string; readonly view?: string }): Promise<VdpUiQueryResult>;
  uiPress(testId: string, view?: string): Promise<VdpUiPressResult>;
  uiWaitFor(params: {
    readonly testId?: string;
    readonly text?: string;
    readonly role?: string;
    readonly view?: string;
    readonly timeoutMs?: number;
  }): Promise<VdpUiWaitForResult>;
  uiGetTree(view?: string, maxDepth?: number): Promise<VdpUiTreeResult>;
  captureScreenshot(outPath: string, target?: "shell" | "webview"): Promise<VdpScreenshotInfo>;
  settle(ms: number): Promise<void>;
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

const UiNodeSchema: z.ZodType<VdpUiNode> = z.lazy(() =>
  z.object({
    testId: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    route: z.string().nullable().optional(),
    pressable: z.boolean().optional(),
    children: z.array(UiNodeSchema).nullable().optional(),
  }),
);

const UiQueryResultSchema: z.ZodType<VdpUiQueryResult> = z.object({
  view: z.string().default("workbench"),
  route: z.string().nullable().optional(),
  count: z.number().int().nonnegative().default(0),
  nodes: z.array(UiNodeSchema).default([]),
});

const UiPressResultSchema: z.ZodType<VdpUiPressResult> = z.object({
  pressed: z.boolean().default(true),
  view: z.string().optional(),
  testId: z.string().optional(),
});

const UiWaitForResultSchema: z.ZodType<VdpUiWaitForResult> = z.object({
  found: z.boolean().default(false),
  node: UiNodeSchema.nullable().optional(),
});

const UiTreeResultSchema: z.ZodType<VdpUiTreeResult> = z.object({
  view: z.string().default("workbench"),
  route: z.string().nullable().optional(),
  nodes: z.array(UiNodeSchema).default([]),
});

const ScreenshotSavedSchema: z.ZodType<VdpScreenshotInfo> = z.object({
  path: z.string(),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
});

const DebugEndpointFileSchema = z.object({
  pid: z.number(),
  port: z.number().int().positive(),
  httpUrl: z.string().min(1),
  wsUrl: z.string().min(1),
});

const ServerReceiptSchema = z.object({
  port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
});

const CreatedEntitySchema = z.union([
  z
    .string()
    .min(1)
    .transform((id) => ({ id })),
  z.object({ id: z.string().min(1) }),
]);

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

function parsePositiveInt(flag: string, raw: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  return parsed;
}

function parsePort(raw: string): number {
  const port = parsePositiveInt("--port", raw);
  if (port > 65_535) {
    throw new Error(`--port must be between 1 and 65535 (got "${raw}")`);
  }
  return port;
}

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

export function flattenUiNodes(nodes: readonly VdpUiNode[]): VdpUiNode[] {
  const flat: VdpUiNode[] = [];
  const visit = (list: readonly VdpUiNode[]) => {
    for (const node of list) {
      flat.push(node);
      if (node.children && node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return flat;
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

async function captureStepShot(driver: VdpDriver, shotsDir: string, fileName: string, shellErrors: string[]): Promise<FlowScreenshot> {
  const pngPath = resolve(shotsDir, fileName);
  const saved = await driver.captureScreenshot(pngPath, "shell");
  const diskBytes = existsSync(pngPath) ? statSync(pngPath).size : 0;
  const bytes = diskBytes > 0 ? diskBytes : saved.bytes;
  if (bytes <= 0) {
    shellErrors.push(`screenshot missing or empty: ${pngPath}`);
  }
  return {
    path: pngPath,
    relPath: `shots/${basename(pngPath)}`,
    width: Math.max(0, Math.round(saved.width)),
    height: Math.max(0, Math.round(saved.height)),
    bytes,
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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-issues-board.png", shellErrors);
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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-new-issue.png", shellErrors);

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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-quick-peek.png", shellErrors);
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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-detail-expanded.png", shellErrors);
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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-issues-list.png", shellErrors);

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
    const screenshot = await captureStepShot(driver, shotsDir, "flow-runs-expanded.png", shellErrors);
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
    const screenshot = await captureStepShot(driver, shotsDir, spec.shotName, shellErrors);
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

const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);

function runChecked(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean; timeoutMs?: number },
): string {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeoutMs ?? 60_000,
  });
  if (res.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    const stdout = typeof res.stdout === "string" ? res.stdout.trim() : "";
    const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(res.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

function runSoft(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 20_000,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
}

function parseJsonOutput<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse JSON from ${label}: ${raw.slice(0, 240)}`, { cause: err });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`unexpected JSON shape from ${label} (${detail}): ${raw.slice(0, 240)}`);
  }
  return parsed.data;
}

function createCliVdpDriver(params: {
  readonly cliBin: string;
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly targetFlags: readonly string[];
}): VdpDriver {
  const runDebug = (args: readonly string[], timeoutMs = 20_000): string =>
    runChecked(params.cliBin, ["debug", ...params.targetFlags, ...args], {
      cwd: params.root,
      env: params.env,
      capture: true,
      timeoutMs,
    });

  return {
    async navigate(route: string): Promise<void> {
      runDebug(["navigate", route, "--json"]);
    },
    async resize(width: number, height: number): Promise<void> {
      runDebug(["resize", String(width), String(height), "--json"]);
    },
    async setTheme(theme: ReviewTheme): Promise<void> {
      runDebug(["theme", theme === "dark" ? "--dark" : "--light", "--json"]);
    },
    async getState(): Promise<unknown> {
      return JSON.parse(runDebug(["state", "--json"]));
    },
    async uiQuery(query): Promise<VdpUiQueryResult> {
      const payload: Record<string, string> = {};
      if (query.testId !== undefined) payload.testId = query.testId;
      if (query.text !== undefined) payload.text = query.text;
      if (query.role !== undefined) payload.role = query.role;
      if (query.view !== undefined) payload.view = query.view;
      const raw = runDebug(["call", "UI.query", JSON.stringify(payload), "--json"]);
      return parseJsonOutput(raw, UiQueryResultSchema, "UI.query");
    },
    async uiPress(testId: string, view?: string): Promise<VdpUiPressResult> {
      const payload: Record<string, string> = { testId };
      if (view !== undefined) payload.view = view;
      const raw = runDebug(["call", "UI.press", JSON.stringify(payload), "--json"]);
      return parseJsonOutput(raw, UiPressResultSchema, `UI.press(${testId})`);
    },
    async uiWaitFor(wait): Promise<VdpUiWaitForResult> {
      const args = ["ui-wait"];
      if (wait.testId !== undefined) args.push("--test-id", wait.testId);
      if (wait.text !== undefined) args.push("--text", wait.text);
      if (wait.view !== undefined) args.push("--view", wait.view);
      args.push("--timeout-ms", String(wait.timeoutMs ?? 4_000), "--json");
      const res = runSoft(params.cliBin, ["debug", ...params.targetFlags, ...args], {
        cwd: params.root,
        env: params.env,
        timeoutMs: (wait.timeoutMs ?? 4_000) + 4_000,
      });
      if (!res.ok) return { found: false };
      try {
        return parseJsonOutput(res.stdout, UiWaitForResultSchema, "UI.waitFor");
      } catch {
        return { found: false };
      }
    },
    async uiGetTree(view = "workbench", maxDepth = 10): Promise<VdpUiTreeResult> {
      const raw = runDebug(["ui-tree", "--view", view, "--max-depth", String(maxDepth), "--json"]);
      return parseJsonOutput(raw, UiTreeResultSchema, "UI.getTree");
    },
    async captureScreenshot(outPath: string, target: "shell" | "webview" = "shell"): Promise<VdpScreenshotInfo> {
      const raw = runDebug(["screenshot", outPath, "--target", target, "--json"], 25_000);
      return parseJsonOutput(raw, ScreenshotSavedSchema, `Page.captureScreenshot(${basename(outPath)})`);
    },
    async settle(ms: number): Promise<void> {
      await sleep(ms);
    },
  };
}

function isolatedEnv(root: string, homeDir: string, workDir: string, storeDb: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("VIBEVALLEY_") && key !== "DEEPSEEK_API_KEY") {
      env[key] = value;
    }
  }
  return {
    ...env,
    VIBEVALLEY_HOME: homeDir,
    VIBEVALLEY_WORK_ROOT: workDir,
    VIBEVALLEY_STORE: storeDb,
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_DEBUG_PORT: "0",
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_ASSETS: resolve(root, "assets"),
    VIBEVALLEY_DIORAMA_DIST: resolve(root, "assets/diorama"),
    VIBEVALLEY_VOICE_LINE_PORT: "0",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
  };
}

function readValidJsonFile<T>(filePath: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function waitForSandboxReady(
  homeDir: string,
  cliBin: string,
  root: string,
  cliEnv: NodeJS.ProcessEnv,
  appExited: () => number | null,
  logPath: string,
): Promise<void> {
  const debugJsonPath = join(homeDir, "debug.json");
  const serverJsonPath = join(homeDir, "server.json");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const code = appExited();
    if (code !== null) {
      throw new Error(`vibevalley-mac exited early with code ${code} (see ${logPath})`);
    }
    const debugInfo = readValidJsonFile(debugJsonPath, DebugEndpointFileSchema);
    const serverInfo = readValidJsonFile(serverJsonPath, ServerReceiptSchema);
    if (debugInfo && serverInfo) {
      const stateRes = runSoft(cliBin, ["debug", "--home", homeDir, "state", "--json"], { cwd: root, env: cliEnv, timeoutMs: 10_000 });
      if (stateRes.ok) {
        try {
          const check = extractShellErrors(JSON.parse(stateRes.stdout));
          if (check.loaded) return;
        } catch {
          // Retry while shell finishes hydrating its initial state snapshot.
        }
      }
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for VDP readiness in ${homeDir} (see ${logPath})`);
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

function signalGroup(pid: number | undefined, sig: "SIGTERM" | "SIGKILL"): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return true;
    if (errorCode(err) === "EPERM") return false;
    throw err;
  }
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return false;
    if (errorCode(err) === "EPERM") return true;
    throw err;
  }
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

export async function runVdpFlow(options: FlowOptions): Promise<FlowReport> {
  const root = resolve(import.meta.dirname, "../..");
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
  const macBin = resolve(targetDir, "debug/vibevalley-mac");
  const cliBin = resolve(targetDir, "debug/vibevalley");
  const uiBundle = resolve(root, "apps/mac/ui/build/bundle.nshc");
  const uiShellBundle = resolve(root, "apps/mac/ui/build-shell/bundle.nshc");
  const nshBin = resolve(root, ".tools/bin/nsh");

  const isAttached = options.port !== undefined || options.home !== undefined || options.url !== undefined;

  if (!options.skipBuild || !existsSync(cliBin)) {
    runChecked("cargo", ["build", "-p", "vibevalley-cli"], { cwd: root, timeoutMs: 300_000 });
  }

  const shotsDir = resolve(options.outDir, "shots");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  if (isAttached) {
    const targetFlags: string[] = [];
    if (options.home !== undefined) targetFlags.push("--home", options.home);
    if (options.port !== undefined) targetFlags.push("--port", String(options.port));
    if (options.url !== undefined) targetFlags.push("--url", options.url);

    const driver = createCliVdpDriver({ cliBin, root, env: process.env, targetFlags });
    const report = await runFlowScenario(driver, {
      outDir: options.outDir,
      mode: "attached",
      viewport: { width: options.width, height: options.height },
      theme: options.theme,
    });
    writeFileSync(resolve(options.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!report.summary.allPassed) {
      throw new Error(
        `vdp-flow failed (${report.summary.failedSteps} step(s), ${report.summary.totalErrors} error(s)) -> ${resolve(options.outDir, "report.json")}`,
      );
    }
    console.log(
      `vdp-flow: passed ${report.summary.passedSteps}/${report.summary.totalSteps} steps (${report.summary.totalScreenshots} shots) -> ${resolve(options.outDir, "report.json")}`,
    );
    return report;
  }

  if (process.platform === "win32") {
    throw new Error("vdp-flow sandbox mode requires macOS/Unix process groups");
  }

  if (!options.skipBuild || !existsSync(uiBundle) || !existsSync(uiShellBundle)) {
    runChecked(nshBin, ["build", "App.tsx", "-o", "build"], { cwd: resolve(root, "apps/mac/ui"), timeoutMs: 180_000 });
    runChecked(nshBin, ["build", "ShellApp.tsx", "-o", "build-shell"], { cwd: resolve(root, "apps/mac/ui"), timeoutMs: 180_000 });
  }
  if (!options.skipBuild || !existsSync(macBin)) {
    runChecked("cargo", ["build", "-p", "vibevalley-mac", "--features", "shot"], { cwd: root, timeoutMs: 600_000 });
  }

  const sandboxDir = mkdtempSync(join(tmpdir(), "vv-vdp-flow-"));
  const homeDir = join(sandboxDir, "home");
  const workDir = join(sandboxDir, "work");
  const payloadDir = join(sandboxDir, "payloads");
  const storeDb = join(sandboxDir, "state.db");
  const sandboxLogPath = join(sandboxDir, "app.log");
  const outLogPath = resolve(options.outDir, "app.log");
  for (const dir of [homeDir, workDir, payloadDir]) mkdirSync(dir, { recursive: true });

  const appEnv = isolatedEnv(root, homeDir, workDir, storeDb);
  const cliEnv: Record<string, string> = { ...appEnv, VIBEVALLEY_HOME: homeDir };

  const logFd = openSync(sandboxLogPath, "w");
  let child: ChildProcess | undefined;
  let exitCode: number | null = null;
  let exitedPromise: Promise<number> = Promise.resolve(0);

  const onSignal = () => {
    signalGroup(child?.pid, "SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    child = spawn(macBin, [], {
      cwd: root,
      env: appEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);

    exitedPromise = new Promise<number>((done) => {
      child?.once("exit", (code, sig) => {
        exitCode = code ?? (sig ? 128 : 1);
        done(exitCode);
      });
      child?.once("error", () => {
        exitCode = 1;
        done(1);
      });
    });

    await waitForSandboxReady(homeDir, cliBin, root, cliEnv, () => exitCode, sandboxLogPath);
    seedFlowSandbox(cliBin, root, cliEnv, payloadDir);

    const driver = createCliVdpDriver({ cliBin, root, env: cliEnv, targetFlags: ["--home", homeDir] });
    const report = await runFlowScenario(driver, {
      outDir: options.outDir,
      mode: "sandbox",
      viewport: { width: options.width, height: options.height },
      theme: options.theme,
    });

    runSoft(cliBin, ["debug", "--home", homeDir, "key", "cmd-q", "--json"], { cwd: root, env: cliEnv, timeoutMs: 8_000 });
    const quitDeadline = Date.now() + 6_000;
    while (exitCode === null && Date.now() < quitDeadline) {
      await sleep(100);
    }

    writeFileSync(resolve(options.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!report.summary.allPassed) {
      throw new Error(
        `vdp-flow failed (${report.summary.failedSteps} step(s), ${report.summary.totalErrors} error(s)) -> ${resolve(options.outDir, "report.json")}`,
      );
    }
    console.log(
      `vdp-flow: passed ${report.summary.passedSteps}/${report.summary.totalSteps} steps (${report.summary.totalScreenshots} shots) -> ${resolve(options.outDir, "report.json")}`,
    );
    return report;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    if (child && exitCode === null) {
      signalGroup(child.pid, "SIGTERM");
      const termDeadline = Date.now() + 6_000;
      while (groupAlive(child.pid) && Date.now() < termDeadline) {
        await sleep(100);
      }
      if (groupAlive(child.pid)) {
        signalGroup(child.pid, "SIGKILL");
      }
      await exitedPromise;
    }

    if (existsSync(sandboxLogPath)) {
      copyFileSync(sandboxLogPath, outLogPath);
    }
    if (!options.keepSandbox) {
      rmSync(sandboxDir, { recursive: true, force: true });
    } else {
      console.log(`vdp-flow: kept sandbox at ${sandboxDir}`);
    }
  }
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
