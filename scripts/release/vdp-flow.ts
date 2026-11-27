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

export interface FlowViewport {
  readonly width: number;
  readonly height: number;
}

export const VdpBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type VdpBounds = z.infer<typeof VdpBoundsSchema>;

export type FlowUiNode = VdpUiNode & {
  readonly bounds?: VdpBounds | null | undefined;
};

export interface FlowOptions {
  readonly outDir: string;
  readonly port?: number | undefined;
  readonly home?: string | undefined;
  readonly url?: string | undefined;
  readonly themes: readonly ReviewTheme[];
  readonly viewports: readonly FlowViewport[];
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

export const FlowViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const FlowReportSchema = z.object({
  generatedAt: z.string(),
  outDir: z.string(),
  mode: z.enum(["attached", "sandbox"]),
  viewport: FlowViewportSchema,
  theme: z.enum(["light", "dark"]),
  steps: z.array(FlowStepResultSchema),
  summary: FlowSummarySchema,
});

export type FlowReport = z.infer<typeof FlowReportSchema>;

export const FlowMatrixSummarySchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  passedRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
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

export type FlowMatrixSummary = z.infer<typeof FlowMatrixSummarySchema>;

export const FlowMatrixReportSchema = z.object({
  generatedAt: z.string(),
  outDir: z.string(),
  mode: z.enum(["attached", "sandbox"]),
  viewports: z.array(FlowViewportSchema),
  themes: z.array(z.enum(["light", "dark"])),
  runs: z.array(FlowReportSchema),
  summary: FlowMatrixSummarySchema,
});

export type FlowMatrixReport = z.infer<typeof FlowMatrixReportSchema>;

export const DEFAULT_FLOW_VIEWPORTS: readonly FlowViewport[] = [
  { width: 900, height: 720 },
  { width: 1280, height: 800 },
  { width: 1680, height: 1050 },
] as const;

export const DEFAULT_FLOW_THEMES: readonly ReviewTheme[] = ["light", "dark"] as const;

export const KANBAN_LANES = [
  { key: "backlog", testId: "lane-backlog", zh: "需求池", en: "Backlog" },
  { key: "todo", testId: "lane-todo", zh: "待办", en: "Todo" },
  { key: "in_progress", testId: "lane-in_progress", zh: "进行中", en: "In Progress" },
  { key: "in_review", testId: "lane-in_review", zh: "待验收", en: "In Review" },
  { key: "done", testId: "lane-done", zh: "已完成", en: "Done" },
  { key: "canceled", testId: "lane-canceled", zh: "已废弃", en: "Canceled" },
] as const;

export const EXPECTED_RAIL_PLACES = ["dashboard", "chat", "issues", "workspace", "content", "farm", "runtimes", "team", "settings"] as const;

export const SWEEP_ROUTES = [
  { id: "route-runtimes", label: "Runtimes & Engines", route: "/runtimes", waitTestId: "runtimes-page", shotName: "flow-runtimes.png" },
  { id: "route-agents", label: "Agents Roster", route: "/agents", shotName: "flow-agents.png" },
  { id: "route-settings", label: "Settings", route: "/settings", shotName: "flow-settings.png" },
] as const;

const RawFlowShellMetaSchema = z.object({
  theme_dark: z.boolean().optional(),
  diorama: z
    .object({
      kind: z.string().optional(),
      placed: z
        .object({
          w: z.number(),
          h: z.number(),
          scale: z.number().optional(),
        })
        .nullable()
        .optional(),
      scene: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});

export type FarmDioramaDump = NonNullable<z.infer<typeof RawFlowShellMetaSchema>["diorama"]>;

function readNodeBounds(node: VdpUiNode | undefined): VdpBounds | undefined {
  if (!node || !("bounds" in node)) return undefined;
  const parsed = VdpBoundsSchema.safeParse(node.bounds);
  return parsed.success ? parsed.data : undefined;
}

function parseThemeList(raw: string): ReviewTheme[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--themes requires at least one theme (light, dark)");
  }
  const themes: ReviewTheme[] = [];
  for (const part of parts) {
    if (!isReviewTheme(part)) {
      throw new Error(`unsupported theme "${part}" (expected light or dark)`);
    }
    if (!themes.includes(part)) themes.push(part);
  }
  return themes;
}

function parseViewportToken(raw: string): FlowViewport {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)[x×](\d+)$/u.exec(trimmed);
  if (!match) {
    throw new Error(`invalid viewport "${raw}" (expected <width>x<height>, e.g. 1280x800)`);
  }
  const width = parsePositiveInt("--viewports", match[1] ?? "");
  const height = parsePositiveInt("--viewports", match[2] ?? "");
  return { width, height };
}

function parseViewportList(raw: string): FlowViewport[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--viewports requires at least one <width>x<height> entry");
  }
  const seen = new Set<string>();
  const out: FlowViewport[] = [];
  for (const part of parts) {
    const vp = parseViewportToken(part);
    const key = `${vp.width}x${vp.height}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(vp);
    }
  }
  return out;
}

export function parseFlowArgs(argv: readonly string[], cwd = process.cwd()): FlowOptions {
  let outDir = "/tmp/vv-vdp-flow";
  let port: number | undefined;
  let home: string | undefined;
  let url: string | undefined;
  let themes: ReviewTheme[] = [...DEFAULT_FLOW_THEMES];
  let explicitViewports: FlowViewport[] | undefined;
  let explicitWidth: number | undefined;
  let explicitHeight: number | undefined;
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
      themes = [normalized];
    } else if (arg.startsWith("--theme=")) {
      const raw = arg.slice("--theme=".length).trim().toLowerCase();
      if (!isReviewTheme(raw)) throw new Error(`unsupported theme "${raw}" (expected light or dark)`);
      themes = [raw];
    } else if (arg === "--themes") {
      const next = argv[++i];
      if (!next) throw new Error("--themes requires a comma-separated list");
      themes = parseThemeList(next);
    } else if (arg.startsWith("--themes=")) {
      themes = parseThemeList(arg.slice("--themes=".length));
    } else if (arg === "--viewports") {
      const next = argv[++i];
      if (!next) throw new Error("--viewports requires a comma-separated list");
      explicitViewports = parseViewportList(next);
    } else if (arg.startsWith("--viewports=")) {
      explicitViewports = parseViewportList(arg.slice("--viewports=".length));
    } else if (arg === "--width") {
      const next = argv[++i];
      if (!next) throw new Error("--width requires a pixel value");
      explicitWidth = parsePositiveInt("--width", next);
    } else if (arg.startsWith("--width=")) {
      explicitWidth = parsePositiveInt("--width", arg.slice("--width=".length));
    } else if (arg === "--height") {
      const next = argv[++i];
      if (!next) throw new Error("--height requires a pixel value");
      explicitHeight = parsePositiveInt("--height", next);
    } else if (arg.startsWith("--height=")) {
      explicitHeight = parsePositiveInt("--height", arg.slice("--height=".length));
    } else {
      throw new Error(`unknown option "${arg}" (run with --help for usage)`);
    }
  }

  if (explicitViewports !== undefined && (explicitWidth !== undefined || explicitHeight !== undefined)) {
    throw new Error("--viewports cannot be combined with --width or --height");
  }

  const viewports: FlowViewport[] =
    explicitViewports ??
    (explicitWidth !== undefined || explicitHeight !== undefined
      ? [{ width: explicitWidth ?? 1280, height: explicitHeight ?? 800 }]
      : [...DEFAULT_FLOW_VIEWPORTS]);

  return { outDir, port, home, url, themes, viewports, skipBuild, keepSandbox, help };
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
    name: "kanban-6-lanes",
    passed: missingLanes.length === 0,
    detail:
      missingLanes.length === 0
        ? "all 6 Kanban lanes verified (需求池 / 待办 / 进行中 / 待验收 / 已完成 / 已废弃)"
        : `missing Kanban lanes: ${missingLanes.join(", ")}`,
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

export function checkSelectPopupDownward(params: {
  readonly triggerTestId: string;
  readonly triggerNodes: readonly VdpUiNode[];
  readonly popupNodes: readonly VdpUiNode[];
  readonly viewportHeight: number;
}): FlowCheck[] {
  const triggerPresent = params.triggerNodes.length > 0;
  const popupOpened = params.popupNodes.length > 0;
  const triggerBounds = readNodeBounds(params.triggerNodes[0]);
  const popupBounds = readNodeBounds(params.popupNodes[0]);

  let downwardPassed = triggerPresent && popupOpened;
  let downwardDetail = popupOpened
    ? `${params.triggerTestId} trigger stayed visible while popup mounted (bounds unavailable from driver)`
    : `${params.triggerTestId} popup did not mount`;

  if (triggerBounds && popupBounds) {
    const triggerBottom = triggerBounds.y + triggerBounds.height;
    const popupBottom = popupBounds.y + popupBounds.height;
    const opensBelowTrigger = popupBounds.y >= triggerBottom;
    const fitsViewport = popupBottom <= params.viewportHeight;
    downwardPassed = opensBelowTrigger && fitsViewport;
    downwardDetail = downwardPassed
      ? `popup opened strictly downward at y=${popupBounds.y} >= trigger bottom ${triggerBottom} (cover=false, bottom=${popupBottom} <= ${params.viewportHeight})`
      : `popup geometry violated downward cover=false invariant (popupY=${popupBounds.y}, triggerBottom=${triggerBottom}, popupBottom=${popupBottom}, viewportHeight=${params.viewportHeight})`;
  }

  return [
    {
      name: "select-trigger-visible",
      passed: triggerPresent,
      detail: triggerPresent ? `${params.triggerTestId} trigger remained visible` : `${params.triggerTestId} trigger missing`,
    },
    {
      name: "select-popup-opened",
      passed: popupOpened,
      detail: popupOpened
        ? `${params.triggerTestId} dropdown popup opened (${params.popupNodes.length} node(s))`
        : `${params.triggerTestId} dropdown popup did not open`,
    },
    {
      name: "select-popup-downward-cover-false",
      passed: downwardPassed,
      detail: downwardDetail,
    },
  ];
}

/** Matches `IssuePeekModal.tsx` viewport scaling (`min(1260, max(320, min(w-24, round(w*0.88))))`). */
export function expectedPeekModalDimensions(viewport: FlowViewport): { readonly width: number; readonly height: number; readonly marginTop: number } {
  const width = Math.min(1260, Math.max(320, Math.min(viewport.width - 24, Math.round(viewport.width * 0.88))));
  const height = Math.min(940, Math.max(360, Math.min(viewport.height - 32, Math.round(viewport.height * 0.88))));
  const marginTop = Math.max(16, Math.round((viewport.height - height) / 2));
  return { width, height, marginTop };
}

export function checkQuickPeekInvariants(params: {
  readonly cardCount: number;
  readonly peekModalCount?: number | undefined;
  readonly peekExpandCount: number;
  readonly shellRoute: string | null;
  readonly viewport?: FlowViewport | undefined;
  readonly peekSurfaceBounds?: VdpBounds | undefined;
}): FlowCheck[] {
  const stayedOnIssues = params.shellRoute === null || params.shellRoute === "/issues" || params.shellRoute.startsWith("/issues?");
  const modalMounted = (params.peekModalCount ?? params.peekExpandCount) > 0 && params.peekExpandCount > 0;
  const vp = params.viewport ?? { width: 1280, height: 800 };
  const expected = expectedPeekModalDimensions(vp);

  let widePassed = modalMounted;
  let wideDetail = modalMounted ? `IssuePeekModal wide target ${expected.width}x${expected.height} at ${vp.width}x${vp.height}` : "IssuePeekModal not mounted";

  if (params.peekSurfaceBounds) {
    const b = params.peekSurfaceBounds;
    const wideEnough = b.width >= expected.width - 4 && b.width <= vp.width;
    const tallEnough = b.height >= expected.height - 4 && b.height <= vp.height;
    widePassed = modalMounted && wideEnough && tallEnough;
    wideDetail = widePassed
      ? `IssuePeekModal surface ${b.width}x${b.height} matches wide target ${expected.width}x${expected.height}`
      : `IssuePeekModal surface ${b.width}x${b.height} missed wide target ${expected.width}x${expected.height} within ${vp.width}x${vp.height}`;
  }

  return [
    {
      name: "issue-card-available",
      passed: params.cardCount > 0,
      detail: params.cardCount > 0 ? `found ${params.cardCount} issue card(s)` : "no issue-card nodes available on board",
    },
    {
      name: "quick-peek-modal-open",
      passed: modalMounted,
      detail: modalMounted ? "Quick-Peek modal opened with issue-peek-expand" : "issue-peek-expand not found after pressing first issue-card",
    },
    {
      name: "quick-peek-wide-geometry",
      passed: widePassed,
      detail: wideDetail,
    },
    {
      name: "quick-peek-stays-on-issues",
      passed: stayedOnIssues,
      detail: stayedOnIssues ? `remained on ${params.shellRoute ?? "/issues"} without navigating away` : `unexpected route change to ${params.shellRoute}`,
    },
  ];
}

export function checkFarmPhoneOverlayInvariants(params: {
  readonly shellRoute: string | null;
  readonly diorama: FarmDioramaDump | null;
  readonly farmViewCount: number;
  readonly phoneNodes: readonly VdpUiNode[];
  readonly viewport: FlowViewport;
}): FlowCheck[] {
  const onFarmRoute = params.shellRoute === "/farm" || params.shellRoute?.startsWith("/farm/") === true;
  const dioramaPlaced = params.diorama?.placed != null && params.diorama.placed.w > 0 && params.diorama.placed.h > 0;
  const surfaceReady = params.diorama !== null || params.farmViewCount > 0;

  const checks: FlowCheck[] = [
    {
      name: "farm-route-active",
      passed: onFarmRoute,
      detail: onFarmRoute ? `navigated cleanly to ${params.shellRoute}` : `expected /farm route, got ${params.shellRoute ?? "<none>"}`,
    },
    {
      name: "farm-surface-mounted",
      passed: surfaceReady,
      detail: dioramaPlaced
        ? `farm diorama mounted (${params.diorama?.placed?.w}x${params.diorama?.placed?.h})`
        : surfaceReady
          ? "farm surface mounted cleanly"
          : "neither diorama state nor farm view node found on /farm",
    },
  ];

  const phoneNode = params.phoneNodes.find((n) => n.testId === "farm-phone") ?? params.phoneNodes[0];
  if (phoneNode) {
    const phoneBounds = readNodeBounds(phoneNode);
    const fitsViewport =
      phoneBounds === undefined ||
      (phoneBounds.x >= 0 &&
        phoneBounds.y >= 0 &&
        phoneBounds.width > 0 &&
        phoneBounds.height > 0 &&
        phoneBounds.x + phoneBounds.width <= params.viewport.width &&
        phoneBounds.y + phoneBounds.height <= params.viewport.height);
    checks.push({
      name: "farm-phone-overlay",
      passed: fitsViewport,
      detail:
        phoneBounds === undefined
          ? "farm-phone overlay mounted cleanly"
          : fitsViewport
            ? `farm-phone overlay (${phoneBounds.width}x${phoneBounds.height} at ${phoneBounds.x},${phoneBounds.y}) fits ${params.viewport.width}x${params.viewport.height}`
            : `farm-phone overlay (${phoneBounds.width}x${phoneBounds.height} at ${phoneBounds.x},${phoneBounds.y}) overflows ${params.viewport.width}x${params.viewport.height}`,
    });
  } else {
    checks.push({
      name: "farm-phone-overlay",
      passed: surfaceReady,
      detail: surfaceReady ? "farm-phone overlay idle/closed; diorama ready without overlay errors" : "farm surface unavailable for phone overlay check",
    });
  }

  return checks;
}

export function checkNavigationAndThemeParity(params: {
  readonly treeNodes: readonly VdpUiNode[];
  readonly linkNodes?: readonly VdpUiNode[] | undefined;
  readonly theme: ReviewTheme;
  readonly shellThemeDark: boolean | null;
  readonly metricsThemeDark?: boolean | null | undefined;
  readonly viewport: FlowViewport;
}): FlowCheck[] {
  const combined = [...flattenUiNodes(params.treeNodes), ...(params.linkNodes ?? [])];
  const placeNodes = combined.filter((n) => typeof n.testId === "string" && n.testId.startsWith("place-"));
  const checks: FlowCheck[] = [];

  if (placeNodes.length > 0) {
    const seenPlaces = new Set(placeNodes.map((n) => n.testId));
    const missingPlaces = EXPECTED_RAIL_PLACES.filter((id) => !seenPlaces.has(`place-${id}`));
    const clippedPlaces: string[] = [];
    for (const node of placeNodes) {
      const b = readNodeBounds(node);
      if (b && (b.y < 0 || b.y + b.height > params.viewport.height)) {
        clippedPlaces.push(`${node.testId ?? "place"}(${b.y}+${b.height}>${params.viewport.height})`);
      }
    }
    const navPassed = missingPlaces.length === 0 && clippedPlaces.length === 0;
    checks.push({
      name: "rail-navigation-parity",
      passed: navPassed,
      detail: navPassed
        ? `all ${EXPECTED_RAIL_PLACES.length} rail places mounted within ${params.viewport.width}x${params.viewport.height}`
        : [
            missingPlaces.length > 0 ? `missing rail places: ${missingPlaces.join(", ")}` : "",
            clippedPlaces.length > 0 ? `clipped rail places: ${clippedPlaces.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; "),
    });
  }

  const expectedDark = params.theme === "dark";
  const shellMatches = params.shellThemeDark === null || params.shellThemeDark === expectedDark;
  const metricsMatches = params.metricsThemeDark === undefined || params.metricsThemeDark === null || params.metricsThemeDark === expectedDark;
  const themePassed = shellMatches && metricsMatches;

  checks.push({
    name: "theme-scrollbar-parity",
    passed: themePassed,
    detail: themePassed
      ? `theme=${params.theme} synchronized with shell/scrollbar scheme`
      : `theme mismatch for "${params.theme}" (shellThemeDark=${String(params.shellThemeDark)}, metricsThemeDark=${String(params.metricsThemeDark)})`,
  });

  return checks;
}

export function aggregateFlowReport(params: {
  readonly generatedAt?: string;
  readonly outDir: string;
  readonly mode: "attached" | "sandbox";
  readonly viewport: FlowViewport;
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

export function aggregateFlowMatrixReport(params: {
  readonly generatedAt?: string;
  readonly outDir: string;
  readonly mode: "attached" | "sandbox";
  readonly viewports: readonly FlowViewport[];
  readonly themes: readonly ReviewTheme[];
  readonly runs: readonly FlowReport[];
}): FlowMatrixReport {
  const passedRuns = params.runs.filter((r) => r.summary.allPassed).length;
  const failedRuns = params.runs.length - passedRuns;

  let totalSteps = 0;
  let passedSteps = 0;
  let failedSteps = 0;
  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  let totalErrors = 0;
  let totalScreenshots = 0;
  let totalBytes = 0;

  for (const run of params.runs) {
    totalSteps += run.summary.totalSteps;
    passedSteps += run.summary.passedSteps;
    failedSteps += run.summary.failedSteps;
    totalChecks += run.summary.totalChecks;
    passedChecks += run.summary.passedChecks;
    failedChecks += run.summary.failedChecks;
    totalErrors += run.summary.totalErrors;
    totalScreenshots += run.summary.totalScreenshots;
    totalBytes += run.summary.totalBytes;
  }

  return FlowMatrixReportSchema.parse({
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    outDir: params.outDir,
    mode: params.mode,
    viewports: params.viewports.map((vp) => ({ width: vp.width, height: vp.height })),
    themes: [...params.themes],
    runs: [...params.runs],
    summary: {
      totalRuns: params.runs.length,
      passedRuns,
      failedRuns,
      totalSteps,
      passedSteps,
      failedSteps,
      totalChecks,
      passedChecks,
      failedChecks,
      totalErrors,
      totalScreenshots,
      totalBytes,
      allPassed: failedRuns === 0 && failedSteps === 0 && failedChecks === 0 && totalErrors === 0,
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
  readonly shellThemeDark: boolean | null;
  readonly diorama: FarmDioramaDump | null;
  readonly treeNodes: readonly VdpUiNode[];
  readonly uiNodeCount: number;
}> {
  const rawState = await driver.getState();
  const shell = extractShellErrors(rawState);
  const metaParsed = RawFlowShellMetaSchema.safeParse(rawState);
  const shellThemeDark = metaParsed.success && metaParsed.data.theme_dark !== undefined ? metaParsed.data.theme_dark : null;
  const diorama = metaParsed.success && metaParsed.data.diorama !== undefined ? metaParsed.data.diorama : null;
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
    shellThemeDark,
    diorama,
    treeNodes,
    uiNodeCount,
  };
}

async function captureStepShot(driver: VdpDriver, outDir: string, shotsSubdir: string, fileName: string, shellErrors: string[]): Promise<FlowScreenshot> {
  const shotsDir = shotsSubdir ? resolve(outDir, "shots", shotsSubdir) : resolve(outDir, "shots");
  const shot = await captureVdpScreenshot(driver, shotsDir, fileName, shellErrors);
  const relPath = shotsSubdir ? `shots/${shotsSubdir}/${fileName}` : shot.relPath;
  return { ...shot, relPath };
}

export async function runFlowScenario(
  driver: VdpDriver,
  options: {
    readonly outDir: string;
    readonly shotsSubdir?: string | undefined;
    readonly mode: "attached" | "sandbox";
    readonly viewport: FlowViewport;
    readonly theme: ReviewTheme;
  },
): Promise<FlowReport> {
  const shotsSubdir = options.shotsSubdir ?? "";
  const steps: FlowStepResult[] = [];

  await driver.resize(options.viewport.width, options.viewport.height);
  await driver.setTheme(options.theme);
  await driver.settle(350);

  // Step 1: Navigate /issues -> verify Kanban 6 lanes, 0 lane-working-slots, rail navigation & theme/scrollbar parity.
  {
    const startedAt = Date.now();
    await driver.navigate("/issues");
    await driver.uiWaitFor({ testId: "issues-page", view: "workbench", timeoutMs: 4_000 });
    await driver.settle(450);

    const { shellRoute, shellErrors, shellThemeDark, treeNodes, uiNodeCount } = await inspectShellAndTree(driver);
    const flatNodes = flattenUiNodes(treeNodes);
    const slotsRes = await driver.uiQuery({ testId: "lane-working-slots", view: "workbench" });
    const linkRes = await driver.uiQuery({ role: "link", view: "workbench" });
    const metrics = driver.getMetrics ? await driver.getMetrics() : null;

    // Also query each lane testId explicitly in case shallow tree pruning omits deep children.
    const queriedLanes: VdpUiNode[] = [...flatNodes];
    for (const lane of KANBAN_LANES) {
      const res = await driver.uiQuery({ testId: lane.testId, view: "workbench" });
      queriedLanes.push(...res.nodes);
      const textRes = await driver.uiQuery({ text: lane.zh, view: "workbench" });
      queriedLanes.push(...textRes.nodes);
    }

    const checks = [
      ...checkKanbanBoardInvariants(queriedLanes, slotsRes.count),
      ...checkNavigationAndThemeParity({
        treeNodes,
        linkNodes: linkRes.nodes,
        theme: options.theme,
        shellThemeDark,
        metricsThemeDark: metrics?.themeDark ?? null,
        viewport: options.viewport,
      }),
    ];
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-issues-board.png", shellErrors);
    steps.push(
      makeStepResult({
        id: "issues-board",
        label: "Issues Kanban Board (6 lanes, 0 working-slots & rail parity)",
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

  // Step 2: Click issue-toolbar-new -> inspect repo & helper dropdowns + downward <Select> popup (cover=false) -> close via issue-new-dialog-never.
  {
    const startedAt = Date.now();
    let dialogOpen = false;
    let repoSelectCount = 0;
    let helperSelectCount = 0;
    let missingRepoCount = 0;
    let missingRuntimeCount = 0;
    let dialogClosedAfterCancel = false;
    let selectChecks: FlowCheck[] = [];
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

      if (repoSelectCount > 0) {
        let triggerRes = await driver.uiQuery({ testId: "issue-new-repo-trigger", view: "workbench" });
        const pressTarget = triggerRes.count > 0 ? "issue-new-repo-trigger" : "issue-new-repo";
        await driver.uiPress(pressTarget, "workbench");
        await driver.settle(200);

        triggerRes = await driver.uiQuery({ testId: pressTarget, view: "workbench" });
        const searchPopupRes = await driver.uiQuery({ testId: "issue-new-repo-search", view: "workbench" });
        const optionPopupRes = searchPopupRes.count > 0 ? searchPopupRes : await driver.uiQuery({ text: "vibevalley", view: "workbench" });
        selectChecks = checkSelectPopupDownward({
          triggerTestId: pressTarget,
          triggerNodes: triggerRes.nodes,
          popupNodes: optionPopupRes.nodes,
          viewportHeight: options.viewport.height,
        });
      }
    } catch (err) {
      extraErrors.push(`NewIssue interaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-new-issue.png", shellErrors);

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

    const checks = [
      ...checkNewIssueDropdownReadiness({
        dialogOpen,
        repoSelectCount,
        helperSelectCount,
        missingRepoCount,
        missingRuntimeCount,
        dialogClosedAfterCancel,
      }),
      ...selectChecks,
    ];
    steps.push(
      makeStepResult({
        id: "new-issue-dialog",
        label: "NewIssue Dialog & Downward Select Readiness",
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

  // Step 3: Click first issue-card -> verify wide Quick-Peek modal opens without leaving /issues.
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    const cards = await driver.uiQuery({ testId: "issue-card", view: "workbench" });
    let peekModalCount = 0;
    let peekExpandCount = 0;
    let peekSurfaceBounds: VdpBounds | undefined;

    if (cards.count > 0) {
      try {
        await driver.uiPress("issue-card", "workbench");
        await driver.uiWaitFor({ testId: "issue-peek-expand", view: "workbench", timeoutMs: 3_000 });
        await driver.settle(300);
        const modalRes = await driver.uiQuery({ testId: "issue-peek-modal", view: "workbench" });
        const surfaceRes = await driver.uiQuery({ testId: "issue-peek-surface", view: "workbench" });
        peekModalCount = modalRes.count;
        peekExpandCount = (await driver.uiQuery({ testId: "issue-peek-expand", view: "workbench" })).count;
        peekSurfaceBounds = readNodeBounds(surfaceRes.nodes[0]) ?? readNodeBounds(modalRes.nodes[0]);
      } catch (err) {
        extraErrors.push(`Quick-Peek interaction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-quick-peek.png", shellErrors);
    const checks = checkQuickPeekInvariants({
      cardCount: cards.count,
      peekModalCount,
      peekExpandCount,
      shellRoute,
      viewport: options.viewport,
      peekSurfaceBounds,
    });

    steps.push(
      makeStepResult({
        id: "quick-peek",
        label: "Wide IssueCard Quick-Peek Modal",
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
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-detail-expanded.png", shellErrors);
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
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-issues-list.png", shellErrors);

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

  // Step 6: Toggle Calendar view (issue-view-calendar) -> verify month grid & week 6 unclipped accessibility.
  {
    const startedAt = Date.now();
    const extraErrors: string[] = [];
    let calendarToggled = false;
    let calendarMounted = false;
    let week6Clipped = false;
    let week6Detail = "calendar view mounted cleanly";

    try {
      const calOpt = await driver.uiQuery({ testId: "issue-view-calendar", view: "workbench" });
      if (calOpt.count > 0) {
        await driver.uiPress("issue-view-calendar", "workbench");
        calendarToggled = true;
        await driver.uiWaitFor({ testId: "issue-calendar", view: "workbench", timeoutMs: 3_000 });
        await driver.settle(300);
      }
      const calRes = await driver.uiQuery({ testId: "issue-calendar", view: "workbench" });
      calendarMounted = calRes.count > 0;
      const week6Res = await driver.uiQuery({ testId: "calendar-week-5", view: "workbench" });
      const week6Bounds = readNodeBounds(week6Res.nodes[0]);
      if (week6Bounds && week6Bounds.y + week6Bounds.height > options.viewport.height) {
        week6Clipped = true;
        week6Detail = `calendar-week-5 bottom (${week6Bounds.y + week6Bounds.height}) exceeds viewport height (${options.viewport.height})`;
      } else if (week6Bounds) {
        week6Detail = `calendar-week-5 bottom (${week6Bounds.y + week6Bounds.height}) fits within viewport height (${options.viewport.height})`;
      }
    } catch (err) {
      extraErrors.push(`Calendar view toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const { shellRoute, shellErrors, uiNodeCount } = await inspectShellAndTree(driver);
    shellErrors.push(...extraErrors);
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-issues-calendar.png", shellErrors);

    const checks: FlowCheck[] = [
      {
        name: "issues-calendar-mounted",
        passed: calendarToggled && calendarMounted,
        detail: calendarMounted ? "issue-calendar mounted cleanly" : "issue-calendar did not mount after pressing issue-view-calendar",
      },
      {
        name: "issues-calendar-week6-accessible",
        passed: calendarMounted && !week6Clipped,
        detail: week6Detail,
      },
    ];
    steps.push(
      makeStepResult({
        id: "issues-calendar",
        label: "Issues Calendar View & Week 6 Accessibility",
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

  // Step 7: Navigate /runs -> click first step row to verify inline structured detail drawer expands.
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
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-runs-expanded.png", shellErrors);
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

  // Step 8: Navigate /farm -> verify diorama surface & phone overlay readiness/bounds.
  {
    const startedAt = Date.now();
    await driver.navigate("/farm");
    await driver.settle(500);

    const { shellRoute, shellErrors, diorama, uiNodeCount } = await inspectShellAndTree(driver);
    const farmRes = await driver.uiQuery({ testId: "farm", view: "workbench" });
    let phoneNodes: readonly VdpUiNode[] = [];
    try {
      const phoneRes = await driver.uiQuery({ testId: "farm-phone", view: "farm-phone" });
      phoneNodes = phoneRes.nodes;
    } catch {
      // farm-phone overlay is only mounted while open; diorama state check remains authoritative.
      phoneNodes = [];
    }

    const checks = checkFarmPhoneOverlayInvariants({
      shellRoute,
      diorama,
      farmViewCount: farmRes.count,
      phoneNodes,
      viewport: options.viewport,
    });
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, "flow-farm.png", shellErrors);
    steps.push(
      makeStepResult({
        id: "route-farm",
        label: "Farm Diorama & Phone Overlay",
        route: "/farm",
        startedAt,
        checks,
        screenshot,
        shellRoute,
        shellErrors,
        uiNodeCount,
      }),
    );
  }

  // Step 9: Navigate /runtimes, /agents, /settings -> assert zero shell/view errors & route/theme parity.
  for (const spec of SWEEP_ROUTES) {
    const startedAt = Date.now();
    await driver.navigate(spec.route);
    if ("waitTestId" in spec && spec.waitTestId) {
      await driver.uiWaitFor({ testId: spec.waitTestId, view: "workbench", timeoutMs: 3_500 });
    }
    await driver.settle(450);

    const { shellRoute, shellErrors, shellThemeDark, uiNodeCount } = await inspectShellAndTree(driver);
    const screenshot = await captureStepShot(driver, options.outDir, shotsSubdir, spec.shotName, shellErrors);
    const routeMatches = shellRoute === null || shellRoute === spec.route || shellRoute.startsWith(`${spec.route}/`);
    const themeMatches = shellThemeDark === null || shellThemeDark === (options.theme === "dark");
    const checks: FlowCheck[] = [
      {
        name: `${spec.id}-zero-shell-errors`,
        passed: shellErrors.length === 0,
        detail: shellErrors.length === 0 ? `${spec.route} loaded with 0 shell/view errors` : `${spec.route} reported ${shellErrors.length} error(s)`,
      },
      {
        name: `${spec.id}-route-theme-parity`,
        passed: routeMatches && themeMatches,
        detail:
          routeMatches && themeMatches
            ? `${spec.route} route and theme=${options.theme} matched`
            : `route=${shellRoute ?? "<none>"}, shellThemeDark=${String(shellThemeDark)} for expected ${spec.route}/${options.theme}`,
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

export async function runFlowMatrix(
  driver: VdpDriver,
  options: {
    readonly outDir: string;
    readonly mode: "attached" | "sandbox";
    readonly viewports: readonly FlowViewport[];
    readonly themes: readonly ReviewTheme[];
  },
): Promise<FlowMatrixReport> {
  const runs: FlowReport[] = [];
  for (const viewport of options.viewports) {
    for (const theme of options.themes) {
      const shotsSubdir = `${viewport.width}x${viewport.height}-${theme}`;
      const runReport = await runFlowScenario(driver, {
        outDir: options.outDir,
        shotsSubdir,
        mode: options.mode,
        viewport,
        theme,
      });
      runs.push(runReport);
    }
  }
  return aggregateFlowMatrixReport({
    outDir: options.outDir,
    mode: options.mode,
    viewports: options.viewports,
    themes: options.themes,
    runs,
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
    [
      "## Flow Verification Seed",
      "Exercises Kanban 6-lane layout, downward Select dropdowns, wide Quick-Peek modal, full-screen Detail expansion, List/Calendar views, and Farm overlay.",
    ].join("\n"),
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
  --out <dir>              Output directory for report.json and shots/ (default: /tmp/vv-vdp-flow)
  --port <port>            Attach to a running VibeValley app on loopback VDP port
  --home <dir>             Attach to a running VibeValley app using its VIBEVALLEY_HOME debug.json
  --url <url>              Attach to an explicit VDP WebSocket/HTTP URL
  --theme <light|dark>     Run a single theme mode
  --themes <list>          Comma-separated themes (default: light,dark)
  --viewports <list>       Comma-separated WxH viewports (default: 900x720,1280x800,1680x1050)
  --width <px>             Single viewport logical width in pixels (overrides --viewports)
  --height <px>            Single viewport logical height in pixels (overrides --viewports)
  --skip-build             Reuse existing vibevalley-mac, vibevalley CLI, and UI bundles in sandbox mode
  --keep-sandbox           Preserve temporary sandbox directory after exit
  -h, --help               Show this help message`);
}

function writeAndCheckFlowReport(outDir: string, report: FlowMatrixReport): FlowMatrixReport {
  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.summary.allPassed) {
    throw new Error(
      `vdp-flow failed (${report.summary.failedRuns} run(s), ${report.summary.failedSteps} step(s), ${report.summary.totalErrors} error(s)) -> ${resolve(outDir, "report.json")}`,
    );
  }
  console.log(
    `vdp-flow: passed ${report.summary.passedRuns}/${report.summary.totalRuns} runs (${report.summary.passedSteps}/${report.summary.totalSteps} steps, ${report.summary.totalScreenshots} shots) -> ${resolve(outDir, "report.json")}`,
  );
  return report;
}

export async function runVdpFlow(options: FlowOptions): Promise<FlowMatrixReport> {
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
    const report = await runFlowMatrix(driver, {
      outDir: options.outDir,
      mode: "attached",
      viewports: options.viewports,
      themes: options.themes,
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
      return runFlowMatrix(driver, {
        outDir: options.outDir,
        mode: "sandbox",
        viewports: options.viewports,
        themes: options.themes,
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
