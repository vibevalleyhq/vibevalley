// Opt-in UI inspection probe for VDP (VibeValley DevTools Protocol).
// Completely inert (zero listeners, zero console hooks, zero timers) unless
// the host explicitly enables VDP via `host.params.vdpEnabled === true`.
import { cleanup, host, untracked, windowSize, type ViewRef } from "nsh";
import { z } from "zod";

import { readHostViewName } from "./hostParams";
import { appHistory } from "./router";

export interface VdpUiBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VdpUiNode {
  readonly testId: string;
  readonly role: string;
  readonly text?: string | undefined;
  readonly route?: string | undefined;
  readonly source?: string | undefined;
  readonly bounds?: VdpUiBounds | undefined;
  readonly pressable: boolean;
  readonly children?: readonly VdpUiNode[] | undefined;
}

export interface VdpNodeRegistration {
  readonly testId: string;
  readonly role?: string | undefined;
  readonly text?: string | (() => string | undefined) | undefined;
  readonly route?: string | (() => string | undefined) | undefined;
  readonly source?: string | undefined;
  readonly parentId?: string | undefined;
  readonly getRef?: (() => ViewRef | undefined) | undefined;
  readonly onPress?: (() => void | Promise<void>) | undefined;
}

interface VdpUiError {
  readonly code: number;
  readonly message: string;
}

const VDP_ERR_INVALID_PARAMS = -32602;
const VDP_ERR_UNAVAILABLE = -32000;
const VDP_ERR_TIMEOUT = -32001;

const VdpUiReqSchema = z.object({
  type: z.exactOptional(z.literal("vdp_ui_req")),
  reqId: z.string().min(1),
  method: z.enum(["UI.getTree", "UI.query", "UI.press", "UI.waitFor"]),
  params: z.exactOptional(z.record(z.string(), z.unknown())),
});

const VdpUiConfigSchema = z.object({
  type: z.exactOptional(z.literal("vdp_ui_config")),
  logEnabled: z.boolean(),
});

const GetTreeParamsSchema = z.object({
  view: z.exactOptional(z.string()),
  maxDepth: z.exactOptional(z.number().int().min(0).max(32)),
});

const QueryParamsSchema = z.object({
  testId: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  role: z.exactOptional(z.string()),
  view: z.exactOptional(z.string()),
});

const PressParamsSchema = z.object({
  testId: z.string().min(1),
  view: z.exactOptional(z.string()),
});

const WaitForParamsSchema = z.object({
  testId: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  role: z.exactOptional(z.string()),
  view: z.exactOptional(z.string()),
  timeoutMs: z.exactOptional(z.number().int().min(50).max(30_000)),
});

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
const MAX_LOG_CHARS = 4_096;

const nodes = new Map<string, VdpNodeRegistration>();
let probeInstalled = false;
let probeEnabled = false;
let disposeActiveProbe: (() => void) | undefined;

function noop(): void {}

/** Returns whether VDP probing is active in the current hosted view. */
export function isVdpEnabled(): boolean {
  if (probeInstalled) return probeEnabled;
  return host.available() && host.params.vdpEnabled === true;
}

/** Registers an inspectable/pressable UI node when VDP is enabled; instant no-op when off. */
export function registerVdpNode(registration: VdpNodeRegistration): () => void {
  if (!isVdpEnabled()) return noop;
  nodes.set(registration.testId, registration);
  return () => {
    if (nodes.get(registration.testId) === registration) {
      nodes.delete(registration.testId);
    }
  };
}

/** Registers an inspectable UI node tied to the current nsh reactive owner lifetime. */
export function useVdpNode(registration: VdpNodeRegistration): void {
  if (!isVdpEnabled()) return;
  cleanup(registerVdpNode(registration));
}

function listenDetached(event: string, listener: (payload: unknown) => void): () => void {
  let active = true;
  let off: (() => void) | undefined;
  queueMicrotask(() => {
    if (!active) return;
    off = host.on(event, (payload) => {
      if (active) listener(payload);
    });
  });
  return () => {
    if (!active) return;
    active = false;
    off?.();
    off = undefined;
  };
}

function resolveText(value: string | (() => string | undefined) | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return untracked(value);
  } catch {
    return undefined;
  }
}

async function measureRef(getRef: (() => ViewRef | undefined) | undefined): Promise<VdpUiBounds | undefined> {
  if (!getRef) return undefined;
  let ref: ViewRef | undefined;
  try {
    ref = getRef();
  } catch {
    return undefined;
  }
  if (!ref || typeof ref.measure !== "function") return undefined;
  try {
    const measured = await ref.measure();
    if (!measured) return undefined;
    return {
      x: Math.round(measured.pagePosition.x),
      y: Math.round(measured.pagePosition.y),
      width: Math.round(measured.bounds.size.width),
      height: Math.round(measured.bounds.size.height),
    };
  } catch {
    return undefined;
  }
}

function currentRouteFor(view: string): string | undefined {
  if (view !== "vibevalley" && view !== "vv") return undefined;
  try {
    const loc = appHistory.read();
    return `${loc.pathname}${loc.search}`;
  } catch {
    return undefined;
  }
}

function currentWindowBounds(): VdpUiBounds {
  try {
    const size = untracked(windowSize);
    return { x: 0, y: 0, width: Math.round(size.width), height: Math.round(size.height) };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

async function snapshotNode(reg: VdpNodeRegistration): Promise<VdpUiNode> {
  const text = resolveText(reg.text);
  const route = resolveText(reg.route);
  const bounds = await measureRef(reg.getRef);
  return {
    testId: reg.testId,
    role: reg.role ?? "view",
    ...(text !== undefined ? { text } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(reg.source !== undefined ? { source: reg.source } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    pressable: typeof reg.onPress === "function",
  };
}

async function collectAllNodes(view: string): Promise<{ route?: string | undefined; bounds: VdpUiBounds; list: VdpUiNode[] }> {
  const route = currentRouteFor(view);
  const bounds = currentWindowBounds();
  const rootNode: VdpUiNode = {
    testId: `view:${view}`,
    role: "root",
    ...(route !== undefined ? { route, text: route } : { text: view }),
    bounds,
    pressable: false,
  };
  const registered = await Promise.all([...nodes.values()].map(snapshotNode));
  const list: VdpUiNode[] = [rootNode];
  if (route !== undefined) {
    list.push({
      testId: "route:current",
      role: "route",
      text: route,
      route,
      pressable: false,
    });
  }
  list.push(...registered);
  return { route, bounds, list };
}

async function buildTree(view: string, maxDepth: number): Promise<VdpUiNode> {
  const route = currentRouteFor(view);
  const bounds = currentWindowBounds();
  const rootId = `view:${view}`;
  const entries = [...nodes.values()];
  const snapshots = new Map<string, VdpUiNode>();
  await Promise.all(
    entries.map(async (reg) => {
      snapshots.set(reg.testId, await snapshotNode(reg));
    }),
  );

  const byParent = new Map<string, VdpUiNode[]>();
  const addChild = (parentId: string, child: VdpUiNode) => {
    const existing = byParent.get(parentId);
    if (existing) existing.push(child);
    else byParent.set(parentId, [child]);
  };

  if (route !== undefined) {
    addChild(rootId, {
      testId: "route:current",
      role: "route",
      text: route,
      route,
      pressable: false,
    });
  }

  for (const reg of entries) {
    const snap = snapshots.get(reg.testId);
    if (!snap) continue;
    const parent = reg.parentId !== undefined && snapshots.has(reg.parentId) ? reg.parentId : rootId;
    addChild(parent, snap);
  }

  const attachChildren = (node: VdpUiNode, depth: number): VdpUiNode => {
    if (depth >= maxDepth) return node;
    const kids = byParent.get(node.testId);
    if (!kids || kids.length === 0) return node;
    return {
      ...node,
      children: kids.map((child) => attachChildren(child, depth + 1)),
    };
  };

  return attachChildren(
    {
      testId: rootId,
      role: "root",
      ...(route !== undefined ? { route, text: route } : { text: view }),
      bounds,
      pressable: false,
    },
    0,
  );
}

function matchesQuery(node: VdpUiNode, query: { testId?: string | undefined; text?: string | undefined; role?: string | undefined }): boolean {
  if (query.testId !== undefined && node.testId !== query.testId) return false;
  if (query.role !== undefined && node.role.toLowerCase() !== query.role.toLowerCase()) return false;
  if (query.text !== undefined) {
    const needle = query.text.toLowerCase();
    const hay = `${node.text ?? ""} ${node.route ?? ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLogMessage(args: readonly unknown[]): string {
  const joined = args.map(formatLogArg).join(" ");
  if (joined.length <= MAX_LOG_CHARS) return joined;
  return `${joined.slice(0, MAX_LOG_CHARS)}…`;
}

function postResponse(reqId: string, result?: unknown, error?: VdpUiError): void {
  if (!host.available()) return;
  host.post("action", {
    type: "vdp_ui_res",
    reqId,
    ...(error !== undefined ? { error } : { result }),
  });
}

/**
 * Installs the VDP UI probe on the current hosted view.
 * Does nothing (zero listeners, zero console hooks) unless `host.params.vdpEnabled === true`
 * or `options.enabled === true`.
 */
export function installVdpProbe(options?: { readonly enabled?: boolean | undefined; readonly view?: string | undefined }): () => void {
  if (disposeActiveProbe) {
    disposeActiveProbe();
    disposeActiveProbe = undefined;
  }

  const enabled = options?.enabled ?? (host.available() && host.params.vdpEnabled === true);
  probeInstalled = true;
  probeEnabled = enabled;
  if (!enabled || !host.available()) {
    return noop;
  }

  const view = options?.view ?? readHostViewName();
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  const savedConsole = new Map<ConsoleLevel, (...args: unknown[]) => void>();
  let consoleHooked = false;
  let forwardingLog = false;

  const setLogEnabled = (next: boolean) => {
    if (next === consoleHooked) return;
    if (next) {
      consoleHooked = true;
      for (const level of CONSOLE_LEVELS) {
        const orig = console[level];
        if (typeof orig !== "function") continue;
        savedConsole.set(level, orig);
        console[level] = (...args: unknown[]) => {
          orig.apply(console, args);
          if (forwardingLog || disposed || !host.available()) return;
          forwardingLog = true;
          try {
            host.post("action", {
              type: "vdp_ui_log",
              view,
              level,
              message: formatLogMessage(args),
              time: Date.now(),
            });
          } catch {
            // Never allow debug log forwarding to break app logging.
          } finally {
            forwardingLog = false;
          }
        };
      }
    } else {
      consoleHooked = false;
      for (const [level, orig] of savedConsole) {
        console[level] = orig;
      }
      savedConsole.clear();
    }
  };

  const handleRequest = async (raw: unknown) => {
    const parsed = VdpUiReqSchema.safeParse(raw);
    if (!parsed.success) return;
    const { reqId, method, params = {} } = parsed.data;

    try {
      switch (method) {
        case "UI.getTree": {
          const p = GetTreeParamsSchema.safeParse(params);
          if (!p.success) {
            postResponse(reqId, undefined, { code: VDP_ERR_INVALID_PARAMS, message: p.error.message });
            return;
          }
          const maxDepth = p.data.maxDepth ?? 8;
          const tree = await buildTree(view, maxDepth);
          const route = currentRouteFor(view);
          postResponse(reqId, {
            view,
            ...(route !== undefined ? { route } : {}),
            nodes: [tree],
          });
          return;
        }
        case "UI.query": {
          const p = QueryParamsSchema.safeParse(params);
          if (!p.success) {
            postResponse(reqId, undefined, { code: VDP_ERR_INVALID_PARAMS, message: p.error.message });
            return;
          }
          const { route, list } = await collectAllNodes(view);
          const matched = list.filter((node) => matchesQuery(node, p.data));
          postResponse(reqId, {
            view,
            ...(route !== undefined ? { route } : {}),
            count: matched.length,
            nodes: matched,
          });
          return;
        }
        case "UI.press": {
          const p = PressParamsSchema.safeParse(params);
          if (!p.success) {
            postResponse(reqId, undefined, { code: VDP_ERR_INVALID_PARAMS, message: p.error.message });
            return;
          }
          const reg = nodes.get(p.data.testId);
          if (!reg) {
            postResponse(reqId, undefined, { code: VDP_ERR_UNAVAILABLE, message: `UI node not found: ${p.data.testId}` });
            return;
          }
          if (typeof reg.onPress !== "function") {
            postResponse(reqId, undefined, { code: VDP_ERR_UNAVAILABLE, message: `UI node is not pressable: ${p.data.testId}` });
            return;
          }
          const bounds = await measureRef(reg.getRef);
          await reg.onPress();
          postResponse(reqId, {
            pressed: true,
            view,
            testId: p.data.testId,
            ...(bounds !== undefined ? { bounds } : {}),
          });
          return;
        }
        case "UI.waitFor": {
          const p = WaitForParamsSchema.safeParse(params);
          if (!p.success) {
            postResponse(reqId, undefined, { code: VDP_ERR_INVALID_PARAMS, message: p.error.message });
            return;
          }
          const timeoutMs = p.data.timeoutMs ?? 5_000;
          const startedAt = Date.now();
          const check = async (): Promise<void> => {
            if (disposed) {
              postResponse(reqId, undefined, { code: VDP_ERR_UNAVAILABLE, message: "UI probe disposed" });
              return;
            }
            const { list } = await collectAllNodes(view);
            const matched = list.filter((node) => matchesQuery(node, p.data));
            const elapsedMs = Date.now() - startedAt;
            if (matched.length > 0) {
              postResponse(reqId, { view, matched: true, node: matched[0], elapsedMs });
              return;
            }
            if (elapsedMs >= timeoutMs) {
              postResponse(reqId, undefined, {
                code: VDP_ERR_TIMEOUT,
                message: `UI.waitFor timed out after ${timeoutMs} ms`,
              });
              return;
            }
            const nextDelay = Math.min(50, Math.max(10, timeoutMs - elapsedMs));
            const timer = setTimeout(() => {
              activeTimers.delete(timer);
              void check();
            }, nextDelay);
            activeTimers.add(timer);
          };
          await check();
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      postResponse(reqId, undefined, { code: VDP_ERR_UNAVAILABLE, message });
    }
  };

  const offReq = listenDetached("vdp_ui_req", (payload) => {
    void handleRequest(payload);
  });
  const offConfig = listenDetached("vdp_ui_config", (payload) => {
    const parsed = VdpUiConfigSchema.safeParse(payload);
    if (parsed.success) setLogEnabled(parsed.data.logEnabled);
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    offReq();
    offConfig();
    setLogEnabled(false);
    for (const timer of activeTimers) clearTimeout(timer);
    activeTimers.clear();
    nodes.clear();
    probeInstalled = false;
    probeEnabled = false;
    if (disposeActiveProbe === dispose) disposeActiveProbe = undefined;
  };
  disposeActiveProbe = dispose;
  return dispose;
}
