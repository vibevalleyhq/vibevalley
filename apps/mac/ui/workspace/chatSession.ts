import { z } from "zod";

import type {
  EventTokens,
  RuntimeInfo as ProtocolRuntimeInfo,
  SessionEvent,
  SessionInteractionRequest,
  SessionPermissionDecision,
  SessionPermissionMode,
  SessionPermissionRequest,
  SessionWatchEvent,
  SessionWorkspace,
} from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { call, subscribe } from "../infra/bridge";

export type {
  EventTokens,
  SessionEvent,
  SessionInteractionRequest,
  SessionPermissionDecision,
  SessionPermissionMode,
  SessionPermissionRequest,
  SessionWatchEvent,
  SessionWorkspace,
};

export type ThoughtLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChatPhase = "starting" | "ready" | "working" | "waiting" | "error";

export interface RuntimeModelOption {
  readonly id: string;
  readonly label: string;
  readonly effortLevels: readonly ThoughtLevel[];
  readonly defaultEffort?: ThoughtLevel | undefined;
}

export interface WorkspaceRuntimeOption {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly models: readonly RuntimeModelOption[];
  readonly quotaPct?: number | undefined;
  readonly quotaText?: string | undefined;
  readonly supportsSteer: boolean;
  readonly supportsConfig: boolean;
}

export interface ToolTarget {
  readonly path: string;
  readonly line?: number | undefined;
  readonly canDiff: boolean;
}

export interface ChatTelemetry {
  readonly cachedRead: number;
  readonly uncachedInput: number;
  readonly totalInput: number;
  readonly output: number;
  readonly reasoning: number;
  readonly contextUsed: number;
  readonly contextWindow: number;
  readonly contextPct: number;
  readonly cacheHitPct: number;
  readonly turns: number;
  readonly toolCount: number;
  readonly hasData: boolean;
}

const DEFAULT_EFFORTS: readonly ThoughtLevel[] = ["low", "medium", "high"];

export function asThoughtLevel(value: string | undefined): ThoughtLevel | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return undefined;
  }
}

const FALLBACK_RUNTIMES: readonly WorkspaceRuntimeOption[] = [
  { id: "antigravity", name: "Antigravity", available: true, models: [], supportsSteer: true, supportsConfig: true },
  { id: "claude", name: "Claude Code", available: true, models: [], supportsSteer: true, supportsConfig: true },
  { id: "codex", name: "Codex", available: true, models: [], supportsSteer: true, supportsConfig: true },
];

const runtimeListSchema = z.array(S.RuntimeInfo);

function toWorkspaceRuntime(rt: ProtocolRuntimeInfo): WorkspaceRuntimeOption {
  const models: RuntimeModelOption[] = (rt.models ?? []).map((m) => {
    const levels = m.effortLevels.map(asThoughtLevel).filter((v): v is ThoughtLevel => v !== undefined);
    return {
      id: m.id,
      label: m.name || m.id,
      effortLevels: levels.length > 0 ? levels : DEFAULT_EFFORTS,
      defaultEffort: asThoughtLevel(m.defaultEffort),
    };
  });
  const firstWindow = rt.usage?.status === "ok" ? rt.usage.windows[0] : undefined;
  const quotaPct =
    rt.quota?.left !== undefined
      ? Math.round(rt.quota.left * 100)
      : firstWindow !== undefined
        ? Math.max(0, Math.min(100, Math.round(100 - firstWindow.usedPercent)))
        : undefined;
  return {
    id: rt.id,
    name: rt.preset.label || runtimeDisplayName(rt.id),
    available: rt.installation.status === "available",
    models,
    quotaPct,
    quotaText: rt.quota?.text ?? firstWindow?.label,
    supportsSteer: rt.support.steer,
    supportsConfig: rt.support.inSessionConfig ?? true,
  };
}

export async function fetchWorkspaceRuntimes(): Promise<readonly WorkspaceRuntimeOption[]> {
  const env = await call("runtime.list", {});
  if (env.bizCode !== 0) return FALLBACK_RUNTIMES;
  const parsed = runtimeListSchema.safeParse(env.data);
  if (!parsed.success || parsed.data.length === 0) return FALLBACK_RUNTIMES;
  return parsed.data.map(toWorkspaceRuntime);
}

export function runtimeDisplayName(runtime: string): string {
  switch (runtime) {
    case "antigravity":
      return "Antigravity";
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    default:
      return runtime || "Chat";
  }
}

export function mergeChatSteps(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return [...existing];
  const bySeq = new Map<number, SessionEvent>(existing.map((s) => [s.seq, s]));
  for (const step of incoming) {
    const prev = bySeq.get(step.seq);
    if (!prev || step.revision >= prev.revision) bySeq.set(step.seq, step);
  }
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

/** Joins `tool/call` steps with their matching `tool/result` (`call === seq`) and drops run/usage bounds. */
export function visibleChatSteps(steps: readonly SessionEvent[]): SessionEvent[] {
  const results = new Map<number, SessionEvent>();
  for (const step of steps) {
    if (step.type === "tool/result" && step.call !== undefined) results.set(step.call, step);
  }
  return steps.flatMap((step) => {
    if (step.type === "tool/call") {
      const result = results.get(step.seq);
      if (!result) return [step];
      return [
        {
          ...step,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.ok !== undefined ? { ok: result.ok } : {}),
        },
      ];
    }
    if (
      step.type === "tool/result" ||
      step.type === "run/start" ||
      step.type === "run/end" ||
      step.type === "llm/usage" ||
      step.type === "permission/request" ||
      step.type === "permission/resolved" ||
      step.type === "interaction/request"
    ) {
      return [];
    }
    return [step];
  });
}

const toolInputPathKeys = ["path", "file_path", "filePath", "TargetFile", "AbsolutePath", "file"] as const;
const toolInputLineKeys = ["line", "start_line", "StartLine", "lineNumber", "offset"] as const;

const jsonRecordSchema = z.record(z.string(), z.unknown());

export function extractToolTarget(step: Pick<SessionEvent, "action" | "tool" | "input" | "text">): ToolTarget | undefined {
  let foundPath: string | undefined;
  let foundLine: number | undefined;
  if (step.input !== undefined) {
    try {
      const parsed = jsonRecordSchema.safeParse(JSON.parse(step.input));
      if (parsed.success) {
        const obj = parsed.data;
        for (const key of toolInputPathKeys) {
          const val = obj[key];
          if (typeof val === "string" && val.trim().length > 0) {
            foundPath = val.trim();
            break;
          }
        }
        for (const key of toolInputLineKeys) {
          const val = obj[key];
          if (typeof val === "number" && Number.isFinite(val) && val > 0) {
            foundLine = Math.floor(val);
            break;
          }
        }
      }
    } catch {
      // Non-JSON input; fall back to `step.text`.
    }
  }
  if (!foundPath && (step.action === "read_file" || step.action === "edit_file")) {
    const token = step.text.trim().split(/\s+/u)[0];
    if (token && (token.includes("/") || token.includes("."))) {
      const [rawPath, rawLine] = token.split(":");
      if (rawPath) foundPath = rawPath;
      if (rawLine) {
        const n = Number(rawLine);
        if (Number.isFinite(n) && n > 0) foundLine = Math.floor(n);
      }
    }
  }
  if (!foundPath) return undefined;
  const toolLower = (step.tool ?? "").toLowerCase();
  const canDiff =
    step.action === "edit_file" || toolLower.includes("edit") || toolLower.includes("write") || toolLower.includes("replace") || toolLower.includes("patch");
  return foundLine !== undefined ? { path: foundPath, line: foundLine, canDiff } : { path: foundPath, canDiff };
}

export function computeTelemetry(steps: readonly SessionEvent[], latestTokens?: EventTokens, defaultWindow = 200_000): ChatTelemetry {
  let cachedRead = 0;
  let totalInput = 0;
  let output = 0;
  let reasoning = 0;
  let contextUsed = 0;
  let contextWindow = defaultWindow;
  let turns = 0;
  let toolCount = 0;
  let hasData = false;

  const fold = (tok: EventTokens) => {
    hasData = true;
    cachedRead += Math.max(0, tok.cacheRead);
    const stepTotalIn = Math.max(tok.input, tok.cacheRead);
    totalInput += stepTotalIn;
    output += Math.max(0, tok.output);
    reasoning += Math.max(0, tok.reasoning ?? 0);
    if (tok.contextUsed !== undefined && tok.contextUsed > 0) contextUsed = tok.contextUsed;
    else contextUsed = stepTotalIn;
    if (tok.contextWindow !== undefined && tok.contextWindow > 0) contextWindow = tok.contextWindow;
  };

  for (const step of steps) {
    if (step.type === "user/message" && step.under === undefined) turns += 1;
    if (step.type === "tool/call") toolCount += 1;
    if (step.tokens !== undefined) fold(step.tokens);
  }
  if (!hasData && latestTokens !== undefined) {
    fold(latestTokens);
  } else if (latestTokens !== undefined) {
    if (latestTokens.contextUsed !== undefined && latestTokens.contextUsed > 0) contextUsed = latestTokens.contextUsed;
    if (latestTokens.contextWindow !== undefined && latestTokens.contextWindow > 0) contextWindow = latestTokens.contextWindow;
  }

  const uncachedInput = Math.max(0, totalInput - cachedRead);
  const effectiveWindow = Math.max(1, contextWindow);
  const contextPct = Math.min(100, Math.round((contextUsed / effectiveWindow) * 100));
  const cacheHitPct = totalInput > 0 ? Math.min(100, Math.round((cachedRead / totalInput) * 100)) : 0;

  return {
    cachedRead,
    uncachedInput,
    totalInput,
    output,
    reasoning,
    contextUsed,
    contextWindow: effectiveWindow,
    contextPct,
    cacheHitPct,
    turns,
    toolCount,
    hasData,
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(n));
}

export interface OpenWorkspaceParams {
  readonly sessionId?: string | undefined;
  readonly cwd: string;
  readonly repo?: string | undefined;
  readonly runtime: string;
  readonly model?: string | undefined;
  readonly effort?: ThoughtLevel | undefined;
  readonly permissionMode?: SessionPermissionMode | undefined;
  readonly title?: string | undefined;
}

export async function openWorkspaceSession(params: OpenWorkspaceParams): Promise<{ ok: true; workspace: SessionWorkspace } | { ok: false; reason: string }> {
  const payload: Record<string, unknown> = { cwd: params.cwd, runtime: params.runtime };
  if (params.sessionId) payload.sessionId = params.sessionId;
  if (params.repo) payload.repo = params.repo;
  if (params.model) payload.model = params.model;
  if (params.effort) payload.effort = params.effort;
  if (params.permissionMode) payload.permissionMode = params.permissionMode;
  if (params.title) payload.title = params.title;
  const env = await call("session.openWorkspace", payload);
  if (env.bizCode !== 0) return { ok: false, reason: env.message };
  const parsed = S.SessionWorkspace.safeParse(env.data);
  if (!parsed.success) return { ok: false, reason: "invalid session.openWorkspace response" };
  return { ok: true, workspace: parsed.data };
}

export async function sendWorkspaceMessage(id: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = await call("session.send", { id, text });
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export async function stopWorkspaceSession(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = await call("session.stop", { id });
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export async function setWorkspaceConfig(
  id: string,
  config: { model?: string; effort?: ThoughtLevel; permissionMode?: SessionPermissionMode },
): Promise<{ ok: true; workspace?: SessionWorkspace } | { ok: false; reason: string }> {
  const payload: Record<string, unknown> = { id };
  if (config.model !== undefined) payload.model = config.model;
  if (config.effort !== undefined) payload.effort = config.effort;
  if (config.permissionMode !== undefined) payload.permissionMode = config.permissionMode;
  const env = await call("session.setConfig", payload);
  if (env.bizCode !== 0) return { ok: false, reason: env.message };
  const parsed = S.SessionWorkspace.safeParse(env.data);
  return parsed.success ? { ok: true, workspace: parsed.data } : { ok: true };
}

export async function respondWorkspaceInteraction(
  id: string,
  requestId: string,
  decision: { kind: "select"; optionId: string } | { kind: "custom"; text: string } | { kind: "cancel" },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payload: Record<string, unknown> = { id, requestId };
  switch (decision.kind) {
    case "select":
      payload.optionId = decision.optionId;
      break;
    case "custom":
      payload.text = decision.text;
      break;
    case "cancel":
      payload.cancelled = true;
      break;
  }
  const env = await call("session.respondInteraction", payload);
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export async function respondWorkspacePermission(
  id: string,
  requestId: string,
  decision: SessionPermissionDecision,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = await call("session.respondPermission", { id, requestId, decision });
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export function watchWorkspaceSession(id: string, onEvent: (event: SessionWatchEvent) => void, onEnd?: () => void, afterSeq?: number): () => void {
  const payload = afterSeq !== undefined ? { id, afterSeq } : { id };
  return subscribe(
    "session.watch",
    payload,
    (raw) => {
      const parsed = S.SessionWatchEvent.safeParse(raw);
      if (parsed.success) onEvent(parsed.data);
    },
    () => onEnd?.(),
  );
}
