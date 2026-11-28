import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { z } from "zod";

import {
  countUiTreeNodes,
  extractShellErrors,
  REVIEW_THEMES,
  type ReviewTheme,
  type VdpDriver,
  type VdpLayoutDump,
  type VdpPageMetrics,
  type VdpUiBounds,
  type VdpUiNode,
  type VdpUiQueryResult,
  type VdpUiTreeResult,
} from "./client.ts";
import { renderScenarioGalleryHtml } from "./gallery.ts";
import { assertInlineLayoutStable, type InlineStabilityOptions, type LayoutDiffResult } from "./layout.ts";
import { type ScenarioRecordingRecord, ScenarioRecordingRecordSchema, VdpRecorder } from "./recorder.ts";

export interface VdpRpcTransport {
  call(method: string, params?: Record<string, unknown>, options?: { readonly sessionId?: string; readonly timeoutMs?: number }): Promise<unknown>;
  callDecoded<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options?: { readonly sessionId?: string; readonly timeoutMs?: number },
  ): Promise<T>;
}

const ServerEnvelopeSchema = z.object({
  bizCode: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const ScenarioCheckRecordSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

export type ScenarioCheckRecord = z.infer<typeof ScenarioCheckRecordSchema>;

export const ScenarioShotRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  scenario: z.string(),
  theme: z.enum(REVIEW_THEMES),
  route: z.string(),
  path: z.string(),
  relPath: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  uiNodeCount: z.number().int().nonnegative(),
  lastFrameMs: z.number().nullable(),
  shellRoute: z.string().nullable(),
  shellErrors: z.array(z.string()),
});

export type ScenarioShotRecord = z.infer<typeof ScenarioShotRecordSchema>;

export const ScenarioResultSchema = z.object({
  id: z.string(),
  description: z.string(),
  passed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  shots: z.array(ScenarioShotRecordSchema),
  checks: z.array(ScenarioCheckRecordSchema),
  recordings: z.array(ScenarioRecordingRecordSchema).default([]),
});

export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const ScenarioManifestSchema = z.object({
  generatedAt: z.string(),
  outDir: z.string(),
  mode: z.enum(["sandbox", "attached"]),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  themes: z.array(z.enum(REVIEW_THEMES)),
  durationMs: z.number().int().nonnegative(),
  scenarios: z.array(ScenarioResultSchema),
  summary: z.object({
    totalScenarios: z.number().int().nonnegative(),
    passedScenarios: z.number().int().nonnegative(),
    totalShots: z.number().int().nonnegative(),
    totalChecks: z.number().int().nonnegative(),
    failedChecks: z.number().int().nonnegative(),
    totalRecordings: z.number().int().nonnegative().default(0),
    totalErrors: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    allPassed: z.boolean(),
  }),
});

export type ScenarioManifest = z.infer<typeof ScenarioManifestSchema>;

export type VdpUiTarget =
  | string
  | {
      readonly testId?: string | undefined;
      readonly text?: string | undefined;
      readonly role?: string | undefined;
      readonly view?: string | undefined;
      readonly timeoutMs?: number | undefined;
    };

export interface VdpScenarioContextOptions {
  readonly scenarioId: string;
  readonly transport: VdpRpcTransport;
  readonly driver: VdpDriver;
  readonly outDir: string;
  readonly themes: readonly ReviewTheme[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly initialTheme?: ReviewTheme;
  readonly initialRoute?: string;
}

const DEFAULT_SHOT_SETTLE_MS = 140;

function normalizeUiTarget(target: VdpUiTarget): Exclude<VdpUiTarget, string> {
  return typeof target === "string" ? { testId: target } : target;
}

function formatUiTarget(target: VdpUiTarget): string {
  if (typeof target === "string") return `testId=${target}`;
  const parts: string[] = [];
  if (target.testId !== undefined) parts.push(`testId=${target.testId}`);
  if (target.text !== undefined) parts.push(`text=${JSON.stringify(target.text)}`);
  if (target.role !== undefined) parts.push(`role=${target.role}`);
  if (target.view !== undefined) parts.push(`view=${target.view}`);
  return parts.join(", ") || "<empty-target>";
}

function sanitizeShotFilename(rawName: string): string {
  const stem = rawName.trim().replace(/\.png$/iu, "");
  const clean = stem.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${clean || "shot"}.png`;
}

export class VdpScenarioContext {
  readonly scenarioId: string;
  readonly transport: VdpRpcTransport;
  readonly driver: VdpDriver;
  readonly outDir: string;
  readonly defaultThemes: readonly ReviewTheme[];
  readonly viewport: { readonly width: number; readonly height: number };

  private activeTheme: ReviewTheme;
  private activeRoute: string;
  private readonly capturedShots: ScenarioShotRecord[] = [];
  private readonly recordedChecks: ScenarioCheckRecord[] = [];
  private readonly recordedVideos: ScenarioRecordingRecord[] = [];

  constructor(opts: VdpScenarioContextOptions) {
    this.scenarioId = opts.scenarioId;
    this.transport = opts.transport;
    this.driver = opts.driver;
    this.outDir = opts.outDir;
    this.defaultThemes = opts.themes;
    this.viewport = { ...opts.viewport };
    this.activeTheme = opts.initialTheme ?? opts.themes[0] ?? "light";
    this.activeRoute = opts.initialRoute ?? "/";
  }

  get currentTheme(): ReviewTheme {
    return this.activeTheme;
  }

  get currentRoute(): string {
    return this.activeRoute;
  }

  get shots(): readonly ScenarioShotRecord[] {
    return this.capturedShots;
  }

  get checks(): readonly ScenarioCheckRecord[] {
    return this.recordedChecks;
  }

  get recordings(): readonly ScenarioRecordingRecord[] {
    return this.recordedVideos;
  }

  async rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  async rpc<T>(method: string, params: Record<string, unknown> | undefined, schema: z.ZodType<T>): Promise<T>;
  async rpc<T>(method: string, params?: Record<string, unknown>, schema?: z.ZodType<T>): Promise<unknown> {
    const raw = await this.transport.call("Server.invoke", {
      method,
      ...(params !== undefined ? { params } : {}),
    });
    const parsed = ServerEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Server.invoke(${method}) returned invalid envelope: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    if (parsed.data.bizCode !== 0) {
      throw new Error(`Server RPC ${method} failed (bizCode=${parsed.data.bizCode}): ${parsed.data.message}`);
    }
    if (schema !== undefined) {
      const decoded = schema.safeParse(parsed.data.data);
      if (!decoded.success) {
        const detail = decoded.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
        throw new Error(`Server RPC ${method} returned unexpected data shape (${detail})`);
      }
      return decoded.data;
    }
    return parsed.data.data;
  }

  async resize(width: number, height: number): Promise<void> {
    await this.driver.resize(width, height);
  }

  async theme(next: ReviewTheme): Promise<void> {
    await this.driver.setTheme(next);
    this.activeTheme = next;
  }

  async nav(route: string): Promise<void> {
    await this.driver.navigate(route);
    this.activeRoute = route;
  }

  async settle(ms: number): Promise<void> {
    await this.driver.settle(ms);
  }

  async state(): Promise<unknown> {
    return this.driver.getState();
  }

  async metrics(): Promise<VdpPageMetrics | null> {
    if (this.driver.getMetrics === undefined) return null;
    return this.driver.getMetrics();
  }

  async query(params: { readonly testId?: string; readonly text?: string; readonly role?: string; readonly view?: string }): Promise<VdpUiQueryResult> {
    return this.driver.uiQuery(params);
  }

  async tree(view = "workbench", maxDepth = 10): Promise<VdpUiTreeResult> {
    return this.driver.uiGetTree(view, maxDepth);
  }

  async dumpLayout(view?: string, maxDepth = 16): Promise<VdpLayoutDump> {
    if (this.driver.uiDumpLayout === undefined) {
      throw new Error("active VdpDriver does not implement uiDumpLayout");
    }
    return this.driver.uiDumpLayout(view, maxDepth);
  }

  async expectInlineStable(checkName: string, opts: InlineStabilityOptions, action: () => Promise<void>): Promise<LayoutDiffResult> {
    const before = await this.dumpLayout();
    await action();
    await this.settle(60);
    const after = await this.dumpLayout();
    try {
      const diff = assertInlineLayoutStable(before, after, opts);
      this.recordedChecks.push({
        name: checkName,
        passed: true,
        detail: `target=${opts.targetId} maxDelta=${diff.maxDeltaPx}px`,
      });
      return diff;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordedChecks.push({ name: checkName, passed: false, detail: msg });
      throw err;
    }
  }

  async record(
    id: string,
    opts: { readonly label: string; readonly fps?: number | undefined },
    fn: (rec: VdpRecorder) => Promise<void>,
  ): Promise<ScenarioRecordingRecord> {
    const recorder = new VdpRecorder({
      id,
      label: opts.label,
      scenario: this.scenarioId,
      outDir: this.outDir,
      driver: this.driver,
      fps: opts.fps,
    });
    await fn(recorder);
    const rec = recorder.finalize();
    this.recordedVideos.push(rec);
    return rec;
  }

  async wait(target: VdpUiTarget): Promise<VdpUiNode> {
    const q = normalizeUiTarget(target);
    const res = await this.driver.uiWaitFor({
      ...(q.testId !== undefined ? { testId: q.testId } : {}),
      ...(q.text !== undefined ? { text: q.text } : {}),
      ...(q.role !== undefined ? { role: q.role } : {}),
      ...(q.view !== undefined ? { view: q.view } : {}),
      ...(q.timeoutMs !== undefined ? { timeoutMs: q.timeoutMs } : {}),
    });
    if (!res.found || res.node === undefined || res.node === null) {
      throw new Error(`UI.waitFor timed out waiting for (${formatUiTarget(target)}) on route "${this.activeRoute}"`);
    }
    return res.node;
  }

  async waitRoute(prefixOrExact: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastRoute = this.activeRoute;
    while (Date.now() < deadline) {
      const res = await this.driver.uiQuery({ testId: "route:current" });
      const routeNode = res.nodes[0];
      const current = routeNode?.route ?? routeNode?.text ?? "";
      if (current !== "") {
        lastRoute = current;
        this.activeRoute = current;
        if (current === prefixOrExact || current.startsWith(`${prefixOrExact}?`) || current.startsWith(`${prefixOrExact}/`)) {
          return current;
        }
      }
      await this.driver.settle(40);
    }
    throw new Error(`waitRoute("${prefixOrExact}") timed out after ${timeoutMs}ms (last route: "${lastRoute}")`);
  }

  async press(testId: string, view?: string): Promise<void> {
    const res = await this.driver.uiPress(testId, view);
    if (!res.pressed) {
      throw new Error(`UI.press("${testId}") returned pressed=false on route "${this.activeRoute}"`);
    }
  }

  async click(x: number, y: number, opts?: { readonly right?: boolean }): Promise<void> {
    await this.transport.call("Input.dispatchMouse", {
      kind: "click",
      x,
      y,
      button: opts?.right === true ? "right" : "left",
    });
  }

  async hover(x: number, y: number): Promise<void> {
    await this.transport.call("Input.dispatchMouse", {
      kind: "move",
      x,
      y,
    });
  }

  async drag(x: number, y: number, endX: number, endY: number): Promise<void> {
    await this.transport.call("Input.dispatchMouse", {
      kind: "drag",
      x,
      y,
      endX,
      endY,
      button: "left",
    });
  }

  async clickTestId(
    testId: string,
    opts?: { readonly view?: string; readonly offsetX?: number; readonly offsetY?: number; readonly right?: boolean },
  ): Promise<{ readonly x: number; readonly y: number; readonly bounds: VdpUiBounds }> {
    const res = await this.driver.uiQuery({
      testId,
      ...(opts?.view !== undefined ? { view: opts.view } : {}),
    });
    const node = res.nodes.find((n) => n.bounds !== undefined && n.bounds !== null);
    if (node === undefined || node.bounds === undefined || node.bounds === null) {
      throw new Error(`clickTestId("${testId}") found ${res.nodes.length} node(s), none with bounds (route "${this.activeRoute}")`);
    }
    const bounds = node.bounds;
    if (bounds.width <= 0 || bounds.height <= 0) {
      throw new Error(`clickTestId("${testId}") resolved zero-sized bounds (${bounds.width}x${bounds.height})`);
    }
    const x = Math.round(bounds.x + bounds.width / 2 + (opts?.offsetX ?? 0));
    const y = Math.round(bounds.y + bounds.height / 2 + (opts?.offsetY ?? 0));
    await this.click(x, y, opts?.right !== undefined ? { right: opts.right } : undefined);
    return { x, y, bounds };
  }

  async key(keys: string): Promise<void> {
    await this.transport.call("Input.dispatchKey", { keys });
  }

  async type(text: string): Promise<void> {
    await this.transport.call("Input.typeText", { text });
  }

  async assertClean(label = "shell-clean"): Promise<void> {
    const raw = await this.driver.getState();
    const health = extractShellErrors(raw);
    const passed = health.loaded && health.errors.length === 0;
    const detail = passed ? `loaded (${health.route ?? this.activeRoute})` : health.errors.join("; ") || "shell not loaded";
    this.recordedChecks.push({ name: label, passed, detail });
    if (!passed) {
      throw new Error(`assertClean(${label}) failed: ${detail}`);
    }
  }

  async assertPresent(target: VdpUiTarget, minCount = 1): Promise<VdpUiQueryResult> {
    const q = normalizeUiTarget(target);
    const res = await this.driver.uiQuery({
      ...(q.testId !== undefined ? { testId: q.testId } : {}),
      ...(q.text !== undefined ? { text: q.text } : {}),
      ...(q.role !== undefined ? { role: q.role } : {}),
      ...(q.view !== undefined ? { view: q.view } : {}),
    });
    const label = `present:${formatUiTarget(target)}`;
    const passed = res.count >= minCount && res.nodes.length >= minCount;
    const detail = `count=${res.count} (expected >= ${minCount})`;
    this.recordedChecks.push({ name: label, passed, detail });
    if (!passed) {
      throw new Error(`assertPresent(${formatUiTarget(target)}) failed: ${detail} on route "${this.activeRoute}"`);
    }
    return res;
  }

  async forThemes(themes: readonly ReviewTheme[] | undefined, fn: (theme: ReviewTheme) => Promise<void>): Promise<void> {
    const list = themes !== undefined && themes.length > 0 ? themes : this.defaultThemes;
    for (const nextTheme of list) {
      await this.theme(nextTheme);
      await fn(nextTheme);
    }
  }

  async shot(
    name: string,
    opts?: { readonly target?: "shell" | "webview"; readonly label?: string; readonly settleMs?: number; readonly view?: string },
  ): Promise<ScenarioShotRecord> {
    const t0 = Date.now();
    await this.driver.settle(opts?.settleMs ?? DEFAULT_SHOT_SETTLE_MS);

    const fileName = sanitizeShotFilename(name);
    const outPath = resolve(this.outDir, fileName);
    mkdirSync(dirname(outPath), { recursive: true });
    const saved = await this.driver.captureScreenshot(outPath, opts?.target ?? "shell");

    const stateInfo = extractShellErrors(await this.driver.getState());
    const shellErrors = [...stateInfo.errors];
    if (saved.bytes <= 0 || !existsSync(outPath)) {
      shellErrors.push(`screenshot missing or empty: ${outPath}`);
    }
    const pageMetrics = this.driver.getMetrics !== undefined ? await this.driver.getMetrics() : null;
    let uiNodeCount = 0;
    try {
      const treeRes = await this.driver.uiGetTree(opts?.view ?? "workbench", 10);
      uiNodeCount = countUiTreeNodes(treeRes.nodes);
    } catch {
      uiNodeCount = 0;
    }

    const record: ScenarioShotRecord = {
      id: basename(fileName, ".png"),
      label: opts?.label ?? basename(fileName, ".png"),
      scenario: this.scenarioId,
      theme: this.activeTheme,
      route: stateInfo.route ?? this.activeRoute,
      path: outPath,
      relPath: fileName,
      width: Math.max(0, Math.round(saved.width)),
      height: Math.max(0, Math.round(saved.height)),
      bytes: saved.bytes,
      durationMs: Math.max(0, Date.now() - t0),
      uiNodeCount,
      lastFrameMs: pageMetrics?.lastFrameMs ?? null,
      shellRoute: stateInfo.route,
      shellErrors,
    };
    this.capturedShots.push(record);
    return record;
  }
}

export interface VdpScenario {
  readonly id: string;
  readonly description: string;
  readonly run: (v: VdpScenarioContext) => Promise<void>;
}

export function defineScenario(def: VdpScenario): VdpScenario {
  return def;
}

export async function runScenarios(
  scenarios: readonly VdpScenario[],
  opts: {
    readonly transport: VdpRpcTransport;
    readonly driver: VdpDriver;
    readonly outDir: string;
    readonly mode: "sandbox" | "attached";
    readonly themes: readonly ReviewTheme[];
    readonly viewport: { readonly width: number; readonly height: number };
    readonly keepGoing?: boolean;
  },
): Promise<ScenarioManifest> {
  const suiteStart = Date.now();
  mkdirSync(opts.outDir, { recursive: true });

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const start = Date.now();
    const ctx = new VdpScenarioContext({
      scenarioId: scenario.id,
      transport: opts.transport,
      driver: opts.driver,
      outDir: opts.outDir,
      themes: opts.themes,
      viewport: opts.viewport,
    });
    let errorMsg: string | null = null;
    try {
      await scenario.run(ctx);
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    const shotErrorCount = ctx.shots.reduce((sum, s) => sum + s.shellErrors.length, 0);
    const failedCheckCount = ctx.checks.filter((c) => !c.passed).length;
    const passed = errorMsg === null && shotErrorCount === 0 && failedCheckCount === 0;
    results.push({
      id: scenario.id,
      description: scenario.description,
      passed,
      durationMs: Math.max(0, Date.now() - start),
      error: errorMsg,
      shots: [...ctx.shots],
      checks: [...ctx.checks],
      recordings: [...ctx.recordings],
    });
    if (!passed && opts.keepGoing !== true) {
      break;
    }
  }

  const allShots = results.flatMap((r) => r.shots);
  const allChecks = results.flatMap((r) => r.checks);
  const totalRecordings = results.reduce((sum, r) => sum + r.recordings.length, 0);
  const totalErrors = allShots.reduce((sum, s) => sum + s.shellErrors.length, 0);
  const failedChecks = allChecks.filter((c) => !c.passed).length;
  const passedScenarios = results.filter((r) => r.passed).length;
  const totalBytes = allShots.reduce((sum, s) => sum + s.bytes, 0);

  return ScenarioManifestSchema.parse({
    generatedAt: new Date().toISOString(),
    outDir: opts.outDir,
    mode: opts.mode,
    viewport: opts.viewport,
    themes: [...opts.themes],
    durationMs: Math.max(0, Date.now() - suiteStart),
    scenarios: results,
    summary: {
      totalScenarios: results.length,
      passedScenarios,
      totalShots: allShots.length,
      totalChecks: allChecks.length,
      failedChecks,
      totalRecordings,
      totalErrors,
      totalBytes,
      allPassed: passedScenarios === results.length && totalErrors === 0 && failedChecks === 0,
    },
  });
}

export function writeScenarioArtifacts(
  outDir: string,
  manifest: ScenarioManifest,
): {
  readonly manifestPath: string;
  readonly htmlPath: string;
} {
  mkdirSync(outDir, { recursive: true });
  const manifestPath = resolve(outDir, "manifest.json");
  const htmlPath = resolve(outDir, "index.html");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(htmlPath, `${renderScenarioGalleryHtml(manifest)}\n`, "utf8");
  return { manifestPath, htmlPath };
}
