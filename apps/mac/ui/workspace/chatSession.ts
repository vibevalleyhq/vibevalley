import { z } from "zod";

import type {
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
} from "@vibevalley/protocol";
import { PriorityValues } from "@vibevalley/protocol";
import {
  jsonString,
  RuntimeInfo as RuntimeInfoSchema,
  SessionChildTranscript as SessionChildTranscriptSchema,
  SessionEvent as SessionEventSchema,
  SessionWatchEvent as SessionWatchEventSchema,
  SessionWorkspace as SessionWorkspaceSchema,
} from "@vibevalley/protocol/schema";

import { computeTelemetry, extractToolTarget, formatTokens, mergeSteps, shownEvents, type ToolTarget } from "../infra/sessionRuns";
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

const DEFAULT_EFFORTS: readonly ThoughtLevel[] = PriorityValues.filter((p): p is Exclude<Priority, "urgent"> => p !== "urgent").toReversed();

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

const CHAT_STEP_VISIBILITY: Record<SessionEvent["type"], boolean> = {
  "run/start": false,
  "user/message": true,
  "memory/recalled": true,
  "assistant/thinking": true,
  "assistant/message": true,
  "tool/call": true,
  "tool/result": false,
  "permission/request": false,
  "permission/resolved": false,
  "interaction/request": false,
  "interaction/resolved": true,
  "llm/retry": true,
  "llm/usage": false,
  "run/error": true,
  "run/end": false,
};

const chatHiddenStepTypes: ReadonlySet<SessionEvent["type"]> = new Set(SessionEventSchema.shape.type.options.filter((type) => !CHAT_STEP_VISIBILITY[type]));

export function mergeChatSteps(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  return mergeSteps([...existing], incoming, { limit: null, replaceSameRevision: true });
}

/** Joins `tool/call` steps with their matching `tool/result` (`call === seq`) and drops run/usage bounds. */
export function visibleChatSteps(steps: readonly SessionEvent[]): SessionEvent[] {
  return shownEvents(steps, chatHiddenStepTypes);
}

export interface ActivityStep {
  readonly step: SessionEvent;
  readonly durationMs?: number | undefined;
}

export interface ActivityEditedFile {
  readonly path: string;
  readonly line?: number | undefined;
  readonly canDiff: boolean;
}

export interface ActivityCommandPreview {
  readonly seq: number;
  readonly command: string;
  readonly running: boolean;
  readonly failed: boolean;
}

export type TodoStepStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

export interface TodoStep {
  readonly title: string;
  readonly status: TodoStepStatus;
}

export interface TodoChecklist {
  readonly seq: number;
  readonly steps: readonly TodoStep[];
  readonly doneCount: number;
  readonly inProgressCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly activeStep?: TodoStep | undefined;
}

export interface ActivitySummary {
  readonly totalSteps: number;
  readonly thinkingCount: number;
  readonly readCount: number;
  readonly searchCount: number;
  readonly editCount: number;
  readonly commandCount: number;
  readonly otherToolCount: number;
  readonly totalTools: number;
  readonly runningCount: number;
  readonly failedCount: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly editedFiles: readonly ActivityEditedFile[];
  readonly latestCommand?: ActivityCommandPreview | undefined;
}

export type ChatFeedItem =
  | {
      readonly kind: "step";
      readonly key: string;
      readonly step: SessionEvent;
      readonly durationMs?: number | undefined;
      readonly trailing: boolean;
    }
  | {
      readonly kind: "activity";
      readonly key: string;
      readonly steps: readonly ActivityStep[];
      readonly summary: ActivitySummary;
      readonly trailing: boolean;
    };

export interface ToolDetails {
  readonly headline: string;
  readonly formattedInput: string;
  readonly outputLines: number;
}

const JsonObjectInput = jsonString(z.record(z.string(), z.unknown()));

function isIntermediateStep(step: SessionEvent): boolean {
  return step.type === "assistant/thinking" || step.type === "tool/call" || step.type === "memory/recalled";
}

function isPlainRecord(val: unknown): val is Readonly<Record<string, unknown>> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function firstStringField(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function firstPositiveInt(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return Math.floor(val);
  }
  return undefined;
}

function normalizeTodoStatus(raw: unknown): TodoStepStatus | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "done":
    case "completed":
    case "complete":
      return "done";
    case "in_progress":
    case "in-progress":
    case "working":
    case "running":
      return "in_progress";
    case "pending":
    case "todo":
    case "not_started":
      return "pending";
    case "skipped":
    case "cancelled":
    case "canceled":
      return "skipped";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

/** Parses `update_steps` (Antigravity/AMP), `TodoWrite`, or `update_plan` payloads into a structured checklist. */
export function parseTodoChecklist(step: Pick<SessionEvent, "seq" | "type" | "tool" | "input">): TodoChecklist | undefined {
  if (step.type !== "tool/call") return undefined;
  const raw = step.input?.trim() ?? "";
  if (raw === "") return undefined;
  const parsed = JsonObjectInput.safeParse(raw);
  if (!parsed.success) return undefined;
  const obj = parsed.data;
  const toolLower = (step.tool ?? "").toLowerCase();

  let candidates: unknown;
  if (Array.isArray(obj.steps)) {
    candidates = obj.steps;
  } else if ((toolLower.includes("todo") || toolLower.includes("plan") || toolLower.includes("steps")) && Array.isArray(obj.todos)) {
    candidates = obj.todos;
  } else if ((toolLower.includes("todo") || toolLower.includes("plan") || toolLower.includes("steps")) && Array.isArray(obj.plan)) {
    candidates = obj.plan;
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;

  const steps: TodoStep[] = [];
  for (const item of candidates) {
    if (!isPlainRecord(item)) continue;
    const title = firstStringField(item, ["title", "content", "step", "label"]);
    const status = normalizeTodoStatus(item.status) ?? "pending";
    if (title !== undefined) steps.push({ title, status });
  }
  if (steps.length === 0) return undefined;

  let doneCount = 0;
  let inProgressCount = 0;
  let failedCount = 0;
  for (const item of steps) {
    if (item.status === "done") doneCount += 1;
    else if (item.status === "in_progress") inProgressCount += 1;
    else if (item.status === "failed") failedCount += 1;
  }
  const activeStep = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");

  return {
    seq: step.seq,
    steps,
    doneCount,
    inProgressCount,
    failedCount,
    totalCount: steps.length,
    ...(activeStep !== undefined ? { activeStep } : {}),
  };
}

/** Returns the latest `update_steps` / todo checklist from a session transcript, if any. */
export function latestSessionTodos(steps: readonly SessionEvent[]): TodoChecklist | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined) continue;
    const parsed = parseTodoChecklist(step);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function extractCommandText(step: SessionEvent): string | undefined {
  if (step.type !== "tool/call" || step.action !== "run_command") return undefined;
  const raw = step.input?.trim() ?? "";
  if (raw !== "") {
    const parsed = JsonObjectInput.safeParse(raw);
    if (parsed.success) {
      const cmd = firstStringField(parsed.data, ["command", "CommandLine", "cmd"]);
      if (cmd !== undefined) return cmd.replaceAll(/\s+/gu, " ").trim();
    }
  }
  const fallback = step.text
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/^\$\s+/u, "");
  return fallback.length > 0 ? fallback : undefined;
}

function summarizeActivity(run: readonly ActivityStep[], endTime: number): ActivitySummary {
  let thinkingCount = 0;
  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let commandCount = 0;
  let otherToolCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  const editedByPath = new Map<string, ActivityEditedFile>();
  let latestRunningCommand: ActivityCommandPreview | undefined;
  let latestAnyCommand: ActivityCommandPreview | undefined;

  for (const { step } of run) {
    if (step.type === "assistant/thinking") {
      thinkingCount += 1;
      continue;
    }
    if (step.type !== "tool/call") continue;
    if (step.ok === undefined) runningCount += 1;
    else if (step.ok === false) failedCount += 1;

    switch (step.action) {
      case "read_file":
        readCount += 1;
        break;
      case "search":
      case "web":
        searchCount += 1;
        break;
      case "edit_file":
        editCount += 1;
        break;
      case "run_command": {
        commandCount += 1;
        const cmdText = extractCommandText(step);
        if (cmdText !== undefined) {
          const preview: ActivityCommandPreview = {
            seq: step.seq,
            command: cmdText,
            running: step.ok === undefined,
            failed: step.ok === false,
          };
          latestAnyCommand = preview;
          if (preview.running) latestRunningCommand = preview;
        }
        break;
      }
      default:
        otherToolCount += 1;
        break;
    }

    const target: ToolTarget | undefined = extractToolTarget(step);
    if (target !== undefined && target.canDiff) {
      const existing = editedByPath.get(target.path);
      editedByPath.set(target.path, {
        path: target.path,
        line: target.line ?? existing?.line,
        canDiff: true,
      });
    }
  }

  const first = run[0];
  const last = run[run.length - 1];
  const startedAt = first?.step.time ?? endTime;
  const durationMs = first !== undefined && last !== undefined ? Math.max(0, endTime - startedAt) : 0;
  const latestCommand = latestRunningCommand ?? latestAnyCommand;

  return {
    totalSteps: run.length,
    thinkingCount,
    readCount,
    searchCount,
    editCount,
    commandCount,
    otherToolCount,
    totalTools: readCount + searchCount + editCount + commandCount + otherToolCount,
    runningCount,
    failedCount,
    startedAt,
    durationMs,
    editedFiles: [...editedByPath.values()],
    ...(latestCommand !== undefined ? { latestCommand } : {}),
  };
}

/**
 * Groups consecutive intermediate steps (`assistant/thinking`, `tool/call`, `memory/recalled`)
 * into a collapsible activity cluster when 2+ appear back-to-back, while keeping single steps bare.
 */
export function groupChatSteps(steps: readonly SessionEvent[]): ChatFeedItem[] {
  const items: ChatFeedItem[] = [];
  let buffer: ActivityStep[] = [];
  let bufferEndIdx = -1;

  const flush = () => {
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (first === undefined || last === undefined) {
      buffer = [];
      bufferEndIdx = -1;
      return;
    }
    const isTrailing = bufferEndIdx === steps.length - 1;
    if (buffer.length === 1) {
      items.push({
        kind: "step",
        key: `s:${first.step.seq}`,
        step: first.step,
        ...(first.durationMs !== undefined ? { durationMs: first.durationMs } : {}),
        trailing: isTrailing,
      });
    } else {
      const after = steps[bufferEndIdx + 1];
      const endTime = after !== undefined ? after.time : last.step.time;
      items.push({
        kind: "activity",
        key: `g:${first.step.seq}`,
        steps: buffer,
        summary: summarizeActivity(buffer, endTime),
        trailing: isTrailing,
      });
    }
    buffer = [];
    bufferEndIdx = -1;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const next = steps[i + 1];
    const durationMs = next !== undefined ? Math.max(0, next.time - step.time) : undefined;
    if (isIntermediateStep(step)) {
      buffer.push(durationMs !== undefined ? { step, durationMs } : { step });
      bufferEndIdx = i;
    } else {
      flush();
      items.push({
        kind: "step",
        key: `s:${step.seq}`,
        step,
        ...(durationMs !== undefined ? { durationMs } : {}),
        trailing: i === steps.length - 1,
      });
    }
  }
  flush();
  return items;
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

/** Extracts a scannable headline, formatted input, and output line count for a tool step. */
export function formatToolDetails(step: SessionEvent): ToolDetails {
  const raw = step.input?.trim() ?? "";
  const parsed = raw !== "" ? JsonObjectInput.safeParse(raw) : undefined;
  const obj = parsed !== undefined && parsed.success ? parsed.data : undefined;
  const target = extractToolTarget(step);
  const output = step.output ?? "";
  const outputLines = output.length > 0 ? output.split(/\r?\n/u).length : 0;

  let formattedInput = raw;
  if (obj !== undefined) {
    formattedInput = JSON.stringify(obj, null, 2);
  }

  let headline = target?.path ?? (step.text || step.tool || "");
  const todo = parseTodoChecklist(step);
  if (todo !== undefined) {
    headline = todo.activeStep !== undefined ? `${todo.doneCount}/${todo.totalCount} · ${todo.activeStep.title}` : `${todo.doneCount}/${todo.totalCount}`;
  } else if (step.action === "run_command" && obj !== undefined) {
    const cmd = firstStringField(obj, ["command", "CommandLine", "cmd"]);
    if (cmd !== undefined) {
      headline = `$ ${cmd}`;
      const cwd = firstStringField(obj, ["cwd", "Cwd", "workdir", "WorkDir"]);
      formattedInput = cwd !== undefined ? `$ ${cmd}\ncwd: ${cwd}` : `$ ${cmd}`;
    }
  } else if (step.action === "search" && obj !== undefined) {
    const query = firstStringField(obj, ["query", "Query", "pattern", "Pattern"]);
    const inPath = firstStringField(obj, ["path", "SearchPath", "directory", "dir", "Directory"]);
    if (query !== undefined) {
      headline = inPath !== undefined ? `${query} in ${inPath}` : query;
    }
  } else if ((step.action === "read_file" || step.action === "edit_file") && target !== undefined) {
    const startLine = target.line ?? (obj !== undefined ? firstPositiveInt(obj, ["StartLine", "start_line", "line"]) : undefined);
    const endLine = obj !== undefined ? firstPositiveInt(obj, ["EndLine", "end_line"]) : undefined;
    if (startLine !== undefined && endLine !== undefined && endLine > startLine) {
      headline = `${target.path}:${startLine}-${endLine}`;
    } else if (startLine !== undefined) {
      headline = `${target.path}:${startLine}`;
    } else {
      headline = target.path;
    }
  } else if (step.action === "web" && obj !== undefined) {
    const webTarget = firstStringField(obj, ["url", "Url", "query", "Query"]);
    if (webTarget !== undefined) headline = webTarget;
  }

  return {
    headline,
    formattedInput,
    outputLines,
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
