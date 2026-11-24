import { z } from "zod";

import type {
  EventTokens,
  RuntimeInfo as ProtocolRuntimeInfo,
  SessionChildStep,
  SessionEvent,
  SessionInteractionRequest,
  SessionPermissionDecision,
  SessionPermissionMode,
  SessionPermissionRequest,
  SessionSwarmMember,
  SessionSwarmMemberState,
  SessionSwarmMessage,
  SessionSwarmOverview,
  SessionSwarmState,
  SessionSwarmThread,
  SessionWatchEvent,
  SessionWorkspace,
} from "@vibevalley/protocol";
import {
  RuntimeInfo as RuntimeInfoSchema,
  SessionChildTranscript as SessionChildTranscriptSchema,
  SessionWatchEvent as SessionWatchEventSchema,
  SessionWorkspace as SessionWorkspaceSchema,
} from "@vibevalley/protocol/schema";

import { computeTelemetry, extractToolTarget, formatTokens, mergeSteps, shownEvents } from "../features/session/runs";
import { transport } from "../infra/transport";

export {
  computeTelemetry,
  extractToolTarget,
  formatTokens,
  type EventTokens,
  type SessionChildStep,
  type SessionEvent,
  type SessionInteractionRequest,
  type SessionPermissionDecision,
  type SessionPermissionMode,
  type SessionPermissionRequest,
  type SessionSwarmMember,
  type SessionSwarmMemberState,
  type SessionSwarmMessage,
  type SessionSwarmOverview,
  type SessionSwarmState,
  type SessionSwarmThread,
  type SessionWatchEvent,
  type SessionWorkspace,
};

export interface ComposerFile {
  readonly path: string;
  readonly name: string;
  readonly mime: string;
}

export interface BoardTextToken {
  readonly kind: "text" | "mention" | "seq" | "tag";
  readonly value: string;
}

export type ThoughtLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChatPhase = "starting" | "ready" | "working" | "waiting" | "error";

export interface RuntimeModelOption {
  readonly id: string;
  readonly label: string;
  readonly effortLevels: readonly ThoughtLevel[];
  readonly defaultEffort?: ThoughtLevel | undefined;
  readonly isDefault?: boolean | undefined;
}

export interface WorkspaceRuntimeOption {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly models: readonly RuntimeModelOption[];
  readonly defaultModel?: string | undefined;
  readonly quotaPct?: number | undefined;
  readonly quotaText?: string | undefined;
  readonly supportsSteer: boolean;
  readonly supportsConfig: boolean;
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

export const FALLBACK_RUNTIMES: readonly WorkspaceRuntimeOption[] = [
  { id: "antigravity", name: "Antigravity", available: true, models: [], supportsSteer: true, supportsConfig: true },
  { id: "claude", name: "Claude Code", available: true, models: [], supportsSteer: true, supportsConfig: true },
  { id: "codex", name: "Codex", available: true, models: [], supportsSteer: true, supportsConfig: true },
];

const runtimeListSchema = z.array(RuntimeInfoSchema);

export function toWorkspaceRuntime(rt: ProtocolRuntimeInfo): WorkspaceRuntimeOption {
  const refusedEffort = rt.support.refused.effort !== undefined;
  const rawModels = rt.models ?? [];
  const hasPerModelEfforts = rawModels.some((m) => m.effortLevels.some((l) => asThoughtLevel(l) !== undefined));
  const models: RuntimeModelOption[] = rawModels.map((m) => {
    const levels = refusedEffort ? [] : m.effortLevels.map(asThoughtLevel).filter((v): v is ThoughtLevel => v !== undefined);
    const effortLevels: readonly ThoughtLevel[] = levels.length > 0 ? levels : !hasPerModelEfforts && !refusedEffort ? DEFAULT_EFFORTS : [];
    const parsedDefault = asThoughtLevel(m.defaultEffort);
    const defaultEffort = parsedDefault !== undefined && effortLevels.includes(parsedDefault) ? parsedDefault : undefined;
    return {
      id: m.id,
      label: m.name || m.id,
      effortLevels,
      defaultEffort,
      isDefault: m.isDefault,
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
    defaultModel: rt.settings.defaultModel.trim() || undefined,
    quotaPct,
    quotaText: rt.quota?.text ?? firstWindow?.label,
    supportsSteer: rt.support.steer,
    supportsConfig: rt.support.inSessionConfig ?? true,
  };
}

export function preferredModelFor(rt: WorkspaceRuntimeOption | undefined): RuntimeModelOption | undefined {
  if (!rt) return undefined;
  return rt.models.find((m) => m.id === rt.defaultModel) ?? rt.models.find((m) => m.isDefault === true) ?? rt.models[0];
}

export function defaultThoughtLevelFor(model: RuntimeModelOption | undefined): ThoughtLevel | undefined {
  if (!model || model.effortLevels.length === 0) return undefined;
  if (model.defaultEffort !== undefined && model.effortLevels.includes(model.defaultEffort)) return model.defaultEffort;
  return model.effortLevels[0];
}

export function clampThoughtLevel(model: RuntimeModelOption | undefined, current: ThoughtLevel | undefined): ThoughtLevel | undefined {
  if (!model || model.effortLevels.length === 0) return undefined;
  if (current !== undefined && model.effortLevels.includes(current)) return current;
  return defaultThoughtLevelFor(model);
}

export async function fetchWorkspaceRuntimes(): Promise<readonly WorkspaceRuntimeOption[]> {
  const env = await transport().call("runtime.list", {});
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

const chatHiddenStepTypes: ReadonlySet<SessionEvent["type"]> = new Set([
  "tool/result",
  "run/start",
  "run/end",
  "llm/usage",
  "permission/request",
  "permission/resolved",
  "interaction/request",
]);

export function mergeChatSteps(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  return mergeSteps([...existing], incoming, { limit: null, replaceSameRevision: true });
}

/** Joins `tool/call` steps with their matching `tool/result` (`call === seq`) and drops run/usage bounds. */
export function visibleChatSteps(steps: readonly SessionEvent[]): SessionEvent[] {
  return shownEvents(steps, chatHiddenStepTypes);
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
  const env = await transport().call("session.openWorkspace", payload);
  if (env.bizCode !== 0) return { ok: false, reason: env.message };
  const parsed = SessionWorkspaceSchema.safeParse(env.data);
  if (!parsed.success) return { ok: false, reason: "invalid session.openWorkspace response" };
  return { ok: true, workspace: parsed.data };
}

const localPickedFileSchema = z
  .object({
    path: z.string().min(1),
    name: z.string().min(1),
    type: z.string(),
  })
  .nullable();

export async function pickWorkspaceFile(): Promise<ComposerFile | undefined> {
  const env = await transport().call("host.pickFile", {});
  if (env.bizCode !== 0) return undefined;
  const parsed = localPickedFileSchema.safeParse(env.data);
  if (!parsed.success || parsed.data === null) return undefined;
  return { path: parsed.data.path, name: parsed.data.name, mime: parsed.data.type };
}

export async function sendWorkspaceMessage(
  id: string,
  text: string,
  contextFiles?: readonly { readonly path: string }[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payload: Record<string, unknown> = { id, text };
  if (contextFiles !== undefined && contextFiles.length > 0) {
    payload.contextFiles = contextFiles.map((f) => ({ path: f.path }));
  }
  const env = await transport().call("session.send", payload);
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export async function fetchChildTranscript(
  id: string,
  conversationId: string,
  limit = 25,
): Promise<{ ok: true; steps: SessionChildStep[] } | { ok: false; reason: string }> {
  const env = await transport().call("session.childTranscript", { id, conversationId, limit });
  if (env.bizCode !== 0) return { ok: false, reason: env.message };
  const parsed = SessionChildTranscriptSchema.safeParse(env.data);
  if (!parsed.success) return { ok: false, reason: "invalid session.childTranscript response" };
  return { ok: true, steps: parsed.data.steps };
}

const BOARD_TOKEN_RE = /(@[a-zA-Z0-9_-]+|#[0-9]+|\[(?:done|stall)\])/gu;

export function parseBoardTokens(text: string): BoardTextToken[] {
  const tokens: BoardTextToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(BOARD_TOKEN_RE)) {
    const idx = match.index;
    const hit = match[0];
    if (idx > cursor) tokens.push({ kind: "text", value: text.slice(cursor, idx) });
    if (hit.startsWith("@")) tokens.push({ kind: "mention", value: hit });
    else if (hit.startsWith("#")) tokens.push({ kind: "seq", value: hit });
    else tokens.push({ kind: "tag", value: hit });
    cursor = idx + hit.length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ kind: "text", value: text }];
}

export async function stopWorkspaceSession(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = await transport().call("session.stop", { id });
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
  const env = await transport().call("session.setConfig", payload);
  if (env.bizCode !== 0) return { ok: false, reason: env.message };
  const parsed = SessionWorkspaceSchema.safeParse(env.data);
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
  const env = await transport().call("session.respondInteraction", payload);
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export async function respondWorkspacePermission(
  id: string,
  requestId: string,
  decision: SessionPermissionDecision,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = await transport().call("session.respondPermission", { id, requestId, decision });
  return env.bizCode === 0 ? { ok: true } : { ok: false, reason: env.message };
}

export function watchWorkspaceSession(id: string, onEvent: (event: SessionWatchEvent) => void, onEnd?: () => void, afterSeq?: number): () => void {
  const sub = transport().subscribe;
  if (!sub) {
    queueMicrotask(() => onEnd?.());
    return () => {};
  }
  const payload = afterSeq !== undefined ? { id, afterSeq } : { id };
  return sub(
    "session.watch",
    payload,
    (raw) => {
      const parsed = SessionWatchEventSchema.safeParse(raw);
      if (parsed.success) onEvent(parsed.data);
    },
    () => onEnd?.(),
  );
}
