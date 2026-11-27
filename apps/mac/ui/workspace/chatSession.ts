import { z } from "zod";

import type {
  ActivitySummary,
  BoardTextToken,
  ChatFeedItem,
  ChatSessionProjection,
  EventTokens,
  Priority,
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
  TodoChecklist,
  TodoStep,
  ToolDetails,
} from "@vibevalley/protocol";
import { PriorityValues } from "@vibevalley/protocol";
import {
  BoardTextToken as BoardTextTokenSchema,
  ChatSessionProjection as ChatSessionProjectionSchema,
  jsonString,
  RuntimeInfo as RuntimeInfoSchema,
  SessionChildTranscript as SessionChildTranscriptSchema,
  SessionWatchEvent as SessionWatchEventSchema,
  SessionWorkspace as SessionWorkspaceSchema,
  TodoChecklist as TodoChecklistSchema,
  ToolDetails as ToolDetailsSchema,
} from "@vibevalley/protocol/schema";

import { coreBridge } from "../infra/rich";
import { computeTelemetry, extractToolTarget, formatTokens, mergeSteps } from "../infra/sessionRuns";
import { transport } from "../infra/transport";

export {
  computeTelemetry,
  extractToolTarget,
  formatTokens,
  type ActivitySummary,
  type BoardTextToken,
  type ChatFeedItem,
  type ChatSessionProjection,
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
  type TodoChecklist,
  type TodoStep,
  type ToolDetails,
};

export interface ComposerFile {
  readonly path: string;
  readonly name: string;
  readonly mime: string;
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

const DEFAULT_EFFORTS: readonly ThoughtLevel[] = PriorityValues.filter((p): p is Exclude<Priority, "urgent"> => p !== "urgent").toReversed();
const BoardTokenArraySchema = z.array(BoardTextTokenSchema);

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
      ? Math.max(0, Math.min(100, Math.round(rt.quota.left)))
      : firstWindow !== undefined
        ? Math.max(0, Math.min(100, Math.round(100 - firstWindow.usedPercent)))
        : undefined;
  return {
    id: rt.id,
    name: rt.preset.label || rt.id,
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
  if (env.bizCode !== 0) return [];
  const parsed = runtimeListSchema.safeParse(env.data);
  return parsed.success ? parsed.data.map(toWorkspaceRuntime) : [];
}

/** Merges chat transcript events uncapped via Rust `VvCore`, replacing equal revisions. */
export function mergeChatSteps(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  return mergeSteps([...existing], incoming, { limit: null, replaceSameRevision: true });
}

const ChatSessionProjectionJsonSchema = jsonString(ChatSessionProjectionSchema);
const TodoChecklistJsonSchema = jsonString(TodoChecklistSchema);
const ToolDetailsJsonSchema = jsonString(ToolDetailsSchema);

/** Projects the full workspace chat state (`visibleSteps`, `feedItems`, `latestTodos`, `telemetry`, `toolEntries`) via Rust `VvCore`. */
export function projectChatSession(steps: readonly SessionEvent[], latestTokens?: EventTokens, defaultWindow = 200_000): ChatSessionProjection | undefined {
  const json = coreBridge()?.projectChatSession?.(JSON.stringify(steps), latestTokens !== undefined ? JSON.stringify(latestTokens) : null, defaultWindow);
  if (!json) return undefined;
  const parsed = ChatSessionProjectionJsonSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Parses `update_steps` / `TodoWrite` / `update_plan` payloads into a structured checklist via Rust `VvCore`. */
export function parseTodoChecklist(step: Pick<SessionEvent, "seq" | "type" | "tool" | "input">): TodoChecklist | undefined {
  const json = coreBridge()?.parseTodoChecklist?.(
    JSON.stringify({
      revision: 0,
      time: 0,
      text: "",
      ...step,
    }),
  );
  if (!json) return undefined;
  const parsed = TodoChecklistJsonSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Compact wall-clock duration label (`320ms`, `4.2s`, `1m 12s`). */
export function formatDurationMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Single-line collapsed preview for thinking traces. */
export function thinkingPreview(text: string, maxChars = 96): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "";
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Extracts a scannable headline, formatted input, and output line count for a tool step via Rust `VvCore`. */
export function formatToolDetails(step: SessionEvent): ToolDetails {
  const json = coreBridge()?.formatToolDetails?.(JSON.stringify(step));
  if (json !== undefined) {
    const parsed = ToolDetailsJsonSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  const output = step.output ?? "";
  return {
    headline: step.text || step.tool || "",
    formattedInput: step.input?.trim() ?? "",
    outputLines: output.length > 0 ? output.split(/\r?\n/u).length : 0,
  };
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

const BoardTokenArrayJsonSchema = jsonString(BoardTokenArraySchema);

/** Splits swarm board message tokens (`@mention`, `#seq`, `[done]`/`[stall]`) via Rust `VvCore`. */
export function parseBoardTokens(text: string): BoardTextToken[] {
  const json = coreBridge()?.parseBoardTokens?.(text);
  if (json !== undefined) {
    const parsed = BoardTokenArrayJsonSchema.safeParse(json);
    if (parsed.success && parsed.data.length > 0) return parsed.data;
  }
  return [{ kind: "text", value: text }];
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
  if (!parsed.success) {
    console.error("[chatSession] malformed session.setConfig response", { id, issues: parsed.error.issues });
    return { ok: false, reason: parsed.error.message };
  }
  return { ok: true, workspace: parsed.data };
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
      if (!parsed.success) {
        console.error("[chatSession] dropped malformed session.watch event", { id, issues: parsed.error.issues });
        return;
      }
      onEvent(parsed.data);
    },
    () => onEnd?.(),
  );
}
