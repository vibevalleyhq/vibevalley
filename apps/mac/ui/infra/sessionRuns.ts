import { z } from "zod";

import type { EventTokens, SessionEvent } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import { jsonString } from "@vibevalley/protocol/schema";

/** The steps kept for one session's log in the page. */
export const stepLimit = 240;

const defaultHiddenEventTypes: ReadonlySet<SessionEvent["type"]> = new Set(["tool/result", "run/start", "run/end"]);
const JsonObjectInput = jsonString(z.record(z.string(), z.unknown()));
const toolInputPathKeys = ["path", "file_path", "filePath", "TargetFile", "AbsolutePath", "file"] as const;
const toolInputLineKeys = ["line", "start_line", "StartLine", "lineNumber", "offset"] as const;

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

/** By seq and revision, independent of HTTP/live arrival order; capped to `limit` (default `stepLimit`, `null` for uncapped). */
export function mergeSteps(
  log: SessionEvent[],
  incoming: readonly SessionEvent[],
  options?: { readonly limit?: number | null; readonly replaceSameRevision?: boolean },
): SessionEvent[] {
  if (incoming.length === 0) return log;
  const limit = options?.limit === undefined ? stepLimit : options.limit;
  const replaceSameRevision = options?.replaceSameRevision ?? false;
  if (incoming.length === 1) {
    const s = incoming[0];
    if (s === undefined) return log;
    const last = log.at(-1);
    if (!last) return [s];
    if (s.seq > last.seq) {
      if (limit !== null && log.length >= limit) return [...log.slice(log.length - limit + 1), s];
      return [...log, s];
    }
    if (s.seq === last.seq) {
      if (replaceSameRevision ? s.revision < last.revision : s.revision <= last.revision) return log;
      const next = log.slice();
      next[next.length - 1] = s;
      return next;
    }
  }
  const bySeq = new Map(log.map((s) => [s.seq, s]));
  for (const s of incoming) {
    const before = bySeq.get(s.seq);
    if (!before || (replaceSameRevision ? s.revision >= before.revision : s.revision > before.revision)) bySeq.set(s.seq, s);
  }
  const all = [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
  return limit !== null && all.length > limit ? all.slice(all.length - limit) : all;
}

/** A call with its result's output and ok; hidden step types (by default results and run bounds) left out. */
export function shownEvents(log: readonly SessionEvent[], hiddenTypes: ReadonlySet<SessionEvent["type"]> = defaultHiddenEventTypes): SessionEvent[] {
  const results = new Map<number, SessionEvent>();
  for (const e of log) if (e.type === "tool/result" && e.call !== undefined) results.set(e.call, e);
  return log.flatMap((e) => {
    if (hiddenTypes.has(e.type)) return [];
    const result = e.type === "tool/call" ? results.get(e.seq) : undefined;
    if (result) {
      return [
        omitUndefined({
          ...e,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.ok !== undefined ? { ok: result.ok } : {}),
        }),
      ];
    }
    return [e];
  });
}

/** Extracts the target file path, line number, and diff capability from a tool step. */
export function extractToolTarget(step: Pick<SessionEvent, "action" | "tool" | "input" | "text">): ToolTarget | undefined {
  let foundPath: string | undefined;
  let foundLine: number | undefined;
  if (step.input !== undefined) {
    const parsed = JsonObjectInput.safeParse(step.input);
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

/** Aggregates token usage, context fill, turns, and tool counts across a session's steps. */
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

/** Formats a token count compactly (e.g. `62.4k`, `1M`). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(n));
}
