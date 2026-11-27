import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

export const REVIEW_THEMES = ["light", "dark"] as const;
export type ReviewTheme = (typeof REVIEW_THEMES)[number];

export interface VdpUiBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VdpUiNode {
  readonly testId?: string | null | undefined;
  readonly role?: string | null | undefined;
  readonly text?: string | null | undefined;
  readonly route?: string | null | undefined;
  readonly source?: string | null | undefined;
  readonly pressable?: boolean | undefined;
  readonly bounds?: VdpUiBounds | null | undefined;
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

export interface VdpPageMetrics {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly themeDark: boolean;
  readonly lastFrameMs?: number | null | undefined;
}

export interface VdpDriver {
  navigate(route: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  setTheme(theme: ReviewTheme): Promise<void>;
  getState(): Promise<unknown>;
  getMetrics?(): Promise<VdpPageMetrics | null>;
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

const HostedViewDumpSchema = z.object({
  ready: z.boolean().optional(),
  errors: z.array(z.string()).default([]),
});

export const ShellStateSchema = z.object({
  loaded: z.boolean().default(false),
  load_error: z.string().nullable().default(null),
  route: z.string().optional(),
  theme_dark: z.boolean().optional(),
  startup_failure: z.object({ kind: z.string(), summary: z.string() }).nullable().optional(),
  sidebar: HostedViewDumpSchema.nullable().optional(),
  workbench: HostedViewDumpSchema.nullable().optional(),
  inspector: HostedViewDumpSchema.nullable().optional(),
  palette: z.object({ view: HostedViewDumpSchema.optional() }).nullable().optional(),
  projects: z.array(z.object({ tabs: z.array(z.object({ hosted: HostedViewDumpSchema.optional() })).default([]) })).default([]),
});

export const PageMetricsSchema: z.ZodType<VdpPageMetrics> = z.object({
  width: z.number(),
  height: z.number(),
  scaleFactor: z.number(),
  themeDark: z.boolean(),
  lastFrameMs: z.number().nullable().optional(),
});

export const VdpUiBoundsSchema: z.ZodType<VdpUiBounds> = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const UiNodeSchema: z.ZodType<VdpUiNode> = z.lazy(() =>
  z.object({
    testId: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    route: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    pressable: z.boolean().optional(),
    bounds: VdpUiBoundsSchema.nullable().optional(),
    children: z.array(UiNodeSchema).nullable().optional(),
  }),
);

export const UiQueryResultSchema: z.ZodType<VdpUiQueryResult> = z.object({
  view: z.string().default("workbench"),
  route: z.string().nullable().optional(),
  count: z.number().int().nonnegative().default(0),
  nodes: z.array(UiNodeSchema).default([]),
});

export const UiPressResultSchema: z.ZodType<VdpUiPressResult> = z.object({
  pressed: z.boolean().default(true),
  view: z.string().optional(),
  testId: z.string().optional(),
});

export const UiWaitForResultSchema: z.ZodType<VdpUiWaitForResult> = z
  .object({
    matched: z.boolean().optional(),
    found: z.boolean().optional(),
    node: UiNodeSchema.nullable().optional(),
  })
  .transform((val) => ({
    found: val.matched ?? val.found ?? false,
    ...(val.node !== undefined ? { node: val.node } : {}),
  }));

export const UiTreeResultSchema: z.ZodType<VdpUiTreeResult> = z.object({
  view: z.string().default("workbench"),
  route: z.string().nullable().optional(),
  nodes: z.array(UiNodeSchema).default([]),
});

export const DebugEndpointFileSchema = z.object({
  pid: z.number(),
  port: z.number().int().positive(),
  httpUrl: z.string().min(1),
  wsUrl: z.string().min(1),
  token: z.string().min(1).optional(),
});

const WsScreenshotPayloadSchema = z.object({
  data: z.string().min(1),
  mime: z.string().default("image/png"),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const JsonRpcResponseSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});

export interface ResolvedVdpEndpoint {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly token?: string | undefined;
  readonly pid?: number | undefined;
  readonly port?: number | undefined;
}

export function isReviewTheme(value: string): value is ReviewTheme {
  return value === "light" || value === "dark";
}

export function parsePositiveInt(flag: string, raw: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  return parsed;
}

export function countUiTreeNodes(nodes: readonly VdpUiNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children && node.children.length > 0) {
      count += countUiTreeNodes(node.children);
    }
  }
  return count;
}

export function extractShellErrors(rawState: unknown): {
  readonly loaded: boolean;
  readonly route: string | null;
  readonly errors: string[];
} {
  const parsed = ShellStateSchema.safeParse(rawState);
  if (!parsed.success) {
    return {
      loaded: false,
      route: null,
      errors: [`invalid Shell.getState payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`],
    };
  }
  const state = parsed.data;
  const errors: string[] = [];
  if (!state.loaded) errors.push("shell.loaded is false");
  if (state.load_error !== null) errors.push(`load_error: ${state.load_error}`);
  if (state.startup_failure) errors.push(`startup_failure(${state.startup_failure.kind}): ${state.startup_failure.summary}`);
  for (const msg of state.sidebar?.errors ?? []) errors.push(`sidebar: ${msg}`);
  for (const msg of state.workbench?.errors ?? []) errors.push(`workbench: ${msg}`);
  for (const msg of state.inspector?.errors ?? []) errors.push(`inspector: ${msg}`);
  for (const msg of state.palette?.view?.errors ?? []) errors.push(`palette: ${msg}`);
  for (const project of state.projects) {
    for (const tab of project.tabs) {
      for (const msg of tab.hosted?.errors ?? []) errors.push(`pane: ${msg}`);
    }
  }
  return { loaded: state.loaded, route: state.route ?? null, errors };
}

const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);

export function runChecked(
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

export function isolatedEnv(root: string, homeDir: string, workDir: string, storeDb: string): Record<string, string> {
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

export function readValidJsonFile<T>(filePath: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function normalizeExplicitVdpUrl(rawUrl: string, flagToken?: string): ResolvedVdpEndpoint {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("--url must not be empty");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error(`invalid --url "${trimmed}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  let httpScheme: string;
  let wsScheme: string;
  if (parsed.protocol === "ws:" || parsed.protocol === "http:") {
    httpScheme = "http:";
    wsScheme = "ws:";
  } else if (parsed.protocol === "wss:" || parsed.protocol === "https:") {
    httpScheme = "https:";
    wsScheme = "wss:";
  } else {
    throw new Error(`unsupported --url scheme "${parsed.protocol}" (expected ws://, wss://, http://, or https://)`);
  }

  const queryToken = parsed.searchParams.get("token")?.trim() || undefined;
  const token = flagToken?.trim() || queryToken;

  const http = new URL(parsed.toString());
  http.protocol = httpScheme;
  http.search = "";
  http.hash = "";
  const cleanPath = http.pathname.replace(/\/+$/u, "");
  http.pathname = cleanPath === "/devtools" ? "" : cleanPath.endsWith("/devtools") ? cleanPath.slice(0, -"/devtools".length) : cleanPath;

  const ws = new URL(parsed.toString());
  ws.protocol = wsScheme;
  ws.hash = "";
  ws.searchParams.delete("token");
  if (ws.pathname === "" || ws.pathname === "/") ws.pathname = "/devtools";

  const portNum = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
  return {
    httpUrl: http.toString().replace(/\/+$/u, ""),
    wsUrl: ws.toString(),
    token,
    port: portNum !== undefined && Number.isSafeInteger(portNum) && portNum > 0 ? portNum : undefined,
  };
}

export function discoverVdpEndpoint(target: {
  readonly home?: string | undefined;
  readonly port?: number | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
}): ResolvedVdpEndpoint {
  if (target.url !== undefined && target.url !== "") {
    return normalizeExplicitVdpUrl(target.url, target.token);
  }
  const homeInfo = target.home !== undefined && target.home !== "" ? readValidJsonFile(join(target.home, "debug.json"), DebugEndpointFileSchema) : null;
  if (target.port !== undefined) {
    const token = target.token?.trim() || (homeInfo?.port === target.port ? homeInfo.token : undefined);
    return {
      httpUrl: `http://127.0.0.1:${target.port}`,
      wsUrl: `ws://127.0.0.1:${target.port}/devtools`,
      token,
      port: target.port,
    };
  }
  if (!homeInfo) {
    const where = target.home !== undefined && target.home !== "" ? target.home : "<unspecified>";
    throw new Error(`no live VDP debug endpoint in ${where} (missing or stale debug.json)`);
  }
  return {
    httpUrl: homeInfo.httpUrl.replace(/\/+$/u, ""),
    wsUrl: homeInfo.wsUrl,
    token: target.token?.trim() || homeInfo.token,
    pid: homeInfo.pid,
    port: homeInfo.port,
  };
}

export class VdpWsClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { readonly resolve: (val: unknown) => void; readonly reject: (err: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = JsonRpcResponseSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.id === undefined) return;
      const entry = this.pending.get(parsed.data.id);
      if (!entry) return;
      this.pending.delete(parsed.data.id);
      clearTimeout(entry.timer);
      if (parsed.data.error) {
        entry.reject(new Error(`${parsed.data.error.message} (code ${parsed.data.error.code})`));
      } else {
        entry.resolve(parsed.data.result);
      }
    });
    ws.addEventListener("close", () => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("VDP WebSocket connection closed"));
        this.pending.delete(id);
      }
    });
  }

  static connect(endpoint: ResolvedVdpEndpoint, timeoutMs = 5_000): Promise<VdpWsClient> {
    const url = new URL(endpoint.wsUrl);
    if (endpoint.token !== undefined && endpoint.token !== "" && !url.searchParams.has("token")) {
      url.searchParams.set("token", endpoint.token);
    }
    return new Promise((resolveConn, rejectConn) => {
      const ws = new WebSocket(url.toString());
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        rejectConn(new Error(`timed out connecting to VDP at ${endpoint.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveConn(new VdpWsClient(ws));
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectConn(new Error(`failed to connect to VDP at ${endpoint.wsUrl}`));
      });
    });
  }

  call(method: string, params: Record<string, unknown> = {}, options?: { readonly sessionId?: string; readonly timeoutMs?: number }): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
      ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    });
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`VDP call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: resolveCall,
        reject: rejectCall,
      });
      this.ws.send(payload);
    });
  }

  async callDecoded<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options?: { readonly sessionId?: string; readonly timeoutMs?: number },
  ): Promise<T> {
    const val = await this.call(method, params, options);
    const checked = schema.safeParse(val);
    if (!checked.success) {
      const detail = checked.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      throw new Error(`unexpected VDP result for ${method} (${detail})`);
    }
    return checked.data;
  }

  close(): void {
    this.ws.close();
  }
}

export const UpdateStateSchema = z.object({
  ready: z.boolean(),
  state: z.looseObject({ _tag: z.string() }),
});

export const RawScreenshotResultSchema = z.object({
  mime: z.string(),
  data: z.string(),
  width: z.number(),
  height: z.number(),
});

export async function waitForVdpEndpoint(opts: {
  readonly homeDir: string;
  readonly expectedPid?: number;
  readonly timeoutMs?: number;
  readonly appExited?: () => number | null;
  readonly logPath?: string;
}): Promise<ReturnType<typeof discoverVdpEndpoint>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const code = opts.appExited?.();
    if (code !== null && code !== undefined) {
      const logTail = opts.logPath && existsSync(opts.logPath) ? readFileSync(opts.logPath, "utf8").slice(-1500) : "";
      throw new Error(`app exited early (${code}) before writing debug.json${logTail ? `\n--- app.log ---\n${logTail}` : ""}`);
    }
    try {
      const endpoint = discoverVdpEndpoint({ home: opts.homeDir });
      if (opts.expectedPid === undefined || endpoint.pid === opts.expectedPid) {
        return endpoint;
      }
      lastErr = new Error(`debug.json belongs to pid ${String(endpoint.pid)} instead of ${opts.expectedPid}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  const logTail = opts.logPath && existsSync(opts.logPath) ? readFileSync(opts.logPath, "utf8").slice(-1500) : "";
  throw new Error(
    `timed out waiting for VDP endpoint in ${opts.homeDir}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}${
      logTail ? `\n--- app.log ---\n${logTail}` : ""
    }`,
  );
}

export async function captureVdpPngFile(
  client: VdpWsClient,
  outPath: string,
  target: "shell" | "webview" = "shell",
): Promise<{ readonly path: string; readonly width: number; readonly height: number; readonly bytes: number }> {
  const raw = await client.callDecoded("Page.captureScreenshot", { target }, RawScreenshotResultSchema);
  const bytes = Buffer.from(raw.data, "base64");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  return { path: outPath, width: raw.width, height: raw.height, bytes: bytes.length };
}

export function createWsVdpDriver(client: VdpWsClient): VdpDriver {
  return {
    async navigate(route: string): Promise<void> {
      await client.call("Shell.navigate", { route });
    },
    async resize(width: number, height: number): Promise<void> {
      await client.call("Shell.resize", { width, height });
    },
    async setTheme(theme: ReviewTheme): Promise<void> {
      await client.call("Shell.setTheme", { dark: theme === "dark" });
    },
    async getState(): Promise<unknown> {
      return client.call("Shell.getState", {});
    },
    async getMetrics(): Promise<VdpPageMetrics | null> {
      try {
        return await client.callDecoded("Page.getMetrics", {}, PageMetricsSchema);
      } catch {
        return null;
      }
    },
    async uiQuery(query): Promise<VdpUiQueryResult> {
      return client.callDecoded("UI.query", { ...query }, UiQueryResultSchema);
    },
    async uiPress(testId: string, view?: string): Promise<VdpUiPressResult> {
      return client.callDecoded("UI.press", { testId, ...(view !== undefined ? { view } : {}) }, UiPressResultSchema);
    },
    async uiWaitFor(wait): Promise<VdpUiWaitForResult> {
      try {
        return await client.callDecoded("UI.waitFor", { ...wait }, UiWaitForResultSchema, {
          timeoutMs: (wait.timeoutMs ?? 4_000) + 4_000,
        });
      } catch {
        return { found: false };
      }
    },
    async uiGetTree(view = "workbench", maxDepth = 10): Promise<VdpUiTreeResult> {
      return client.callDecoded("UI.getTree", { view, maxDepth }, UiTreeResultSchema);
    },
    async captureScreenshot(outPath: string, target: "shell" | "webview" = "shell"): Promise<VdpScreenshotInfo> {
      const shot = await client.callDecoded("Page.captureScreenshot", { target }, WsScreenshotPayloadSchema, { timeoutMs: 25_000 });
      const buf = Buffer.from(shot.data, "base64");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      return { path: outPath, mime: shot.mime, width: shot.width, height: shot.height, bytes: buf.byteLength };
    },
    async settle(ms: number): Promise<void> {
      await sleep(ms);
    },
  };
}

export async function captureVdpScreenshot(
  driver: VdpDriver,
  shotsDir: string,
  fileName: string,
  shellErrors: string[],
  target: "shell" | "webview" = "shell",
): Promise<{ readonly path: string; readonly relPath: string; readonly width: number; readonly height: number; readonly bytes: number }> {
  const pngPath = resolve(shotsDir, fileName);
  const saved = await driver.captureScreenshot(pngPath, target);
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

export interface VdpWorkspacePaths {
  readonly root: string;
  readonly macBin: string;
  readonly uiBundle: string;
  readonly uiShellBundle: string;
  readonly nshBin: string;
}

export function resolveVdpWorkspacePaths(root: string): VdpWorkspacePaths {
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
  return {
    root,
    macBin: resolve(targetDir, "debug/vibevalley-mac"),
    uiBundle: resolve(root, "apps/mac/ui/build/bundle.nshc"),
    uiShellBundle: resolve(root, "apps/mac/ui/build-shell/bundle.nshc"),
    nshBin: resolve(root, ".tools/bin/nsh"),
  };
}

export function ensureUiBundlesBuilt(paths: VdpWorkspacePaths): void {
  const uiDir = resolve(paths.root, "apps/mac/ui");
  runChecked(paths.nshBin, ["build", "App.tsx", "-o", "build"], { cwd: uiDir, timeoutMs: 180_000 });
  runChecked(paths.nshBin, ["build", "ShellApp.tsx", "-o", "build-shell"], { cwd: uiDir, timeoutMs: 180_000 });
}

export function resolveVdpCargoBuildArgs(): string[] {
  return ["build", "-p", "vibevalley-mac", "--features", "vibevalley-mac/shot"];
}

export function ensureVdpArtifactsBuilt(paths: VdpWorkspacePaths, opts: { readonly skipBuild: boolean }): void {
  if (!opts.skipBuild || !existsSync(paths.uiBundle) || !existsSync(paths.uiShellBundle)) {
    ensureUiBundlesBuilt(paths);
  }
  if (!opts.skipBuild || !existsSync(paths.macBin)) {
    runChecked("cargo", resolveVdpCargoBuildArgs(), { cwd: paths.root, timeoutMs: 600_000 });
  }
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

export async function waitForVdpWorkbenchWs(
  client: VdpWsClient,
  opts: {
    readonly homeDir: string;
    readonly logPath: string;
    readonly appExited?: () => number | null;
    readonly requireWorkbenchReady?: boolean;
    readonly timeoutMs?: number;
  },
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const code = opts.appExited?.();
    if (code !== null && code !== undefined) {
      throw new Error(`vibevalley-mac exited early with code ${code} (see ${opts.logPath})`);
    }
    try {
      const raw = await client.call("Shell.getState", {}, { timeoutMs: 5_000 });
      if (opts.requireWorkbenchReady === true) {
        const parsed = ShellStateSchema.safeParse(raw);
        if (parsed.success && parsed.data.loaded && parsed.data.workbench?.ready === true) return;
      } else if (extractShellErrors(raw).loaded) {
        return;
      }
    } catch {
      // Retry while shell finishes hydrating its initial state snapshot.
    }
    await sleep(120);
  }
  throw new Error(`timed out waiting for VDP workbench readiness in ${opts.homeDir} (see ${opts.logPath})`);
}

/** Spawns an isolated `vibevalley-mac` sandbox and connects a single persistent `VdpWsClient` without spawning CLI helpers. */
export async function withVdpWsSandbox<T>(
  options: {
    readonly prefix: string;
    readonly logTag: string;
    readonly paths: VdpWorkspacePaths;
    readonly outDir: string;
    readonly keepSandbox: boolean;
    readonly requireWorkbenchReady?: boolean;
  },
  fn: (ctx: {
    readonly homeDir: string;
    readonly workDir: string;
    readonly payloadDir: string;
    readonly appEnv: Record<string, string>;
    readonly client: VdpWsClient;
    readonly driver: VdpDriver;
  }) => Promise<T>,
): Promise<T> {
  if (!existsSync(options.paths.macBin)) {
    throw new Error(`missing desktop binary at ${options.paths.macBin} (build vibevalley-mac --features shot first)`);
  }
  const sandboxDir = mkdtempSync(join(tmpdir(), options.prefix));
  const homeDir = join(sandboxDir, "home");
  const workDir = join(sandboxDir, "work");
  const payloadDir = join(sandboxDir, "payloads");
  const storeDb = join(sandboxDir, "state.db");
  const sandboxLogPath = join(sandboxDir, "app.log");
  const outLogPath = resolve(options.outDir, "app.log");
  for (const dir of [homeDir, workDir, payloadDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(options.outDir, { recursive: true });

  const appEnv = isolatedEnv(options.paths.root, homeDir, workDir, storeDb);
  const logFd = openSync(sandboxLogPath, "w");
  let child: ChildProcess | undefined;
  let exitCode: number | null = null;
  let exitedPromise: Promise<number> = Promise.resolve(0);
  let client: VdpWsClient | undefined;

  const onSignal = () => {
    signalGroup(child?.pid, "SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    child = spawn(options.paths.macBin, [], {
      cwd: options.paths.root,
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

    const endpoint = await waitForVdpEndpoint({
      homeDir,
      ...(child.pid !== undefined ? { expectedPid: child.pid } : {}),
      timeoutMs: 30_000,
      appExited: () => exitCode,
      logPath: sandboxLogPath,
    });
    client = await VdpWsClient.connect(endpoint, 10_000);
    await waitForVdpWorkbenchWs(client, {
      homeDir,
      logPath: sandboxLogPath,
      appExited: () => exitCode,
      ...(options.requireWorkbenchReady !== undefined ? { requireWorkbenchReady: options.requireWorkbenchReady } : {}),
    });

    const driver = createWsVdpDriver(client);
    const result = await fn({ homeDir, workDir, payloadDir, appEnv, client, driver });

    try {
      await client.call("Shell.quit", {}, { timeoutMs: 2_000 });
    } catch {
      // Shutdown cleanup proceeds to signal termination if Shell.quit disconnects immediately.
    }
    client.close();
    client = undefined;

    const quitDeadline = Date.now() + 5_000;
    while (exitCode === null && Date.now() < quitDeadline) {
      await sleep(100);
    }

    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    client?.close();

    if (child && exitCode === null) {
      signalGroup(child.pid, "SIGTERM");
      const termDeadline = Date.now() + 5_000;
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
      console.log(`${options.logTag}: kept sandbox at ${sandboxDir}`);
    }
  }
}
