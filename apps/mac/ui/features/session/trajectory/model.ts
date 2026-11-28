import { t } from "@vibevalley/i18n";
import type { SessionEval, SessionEvent } from "@vibevalley/protocol";

import { mix } from "../../../design/tone";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { cacheHit, type Lane, secondsText, tokensText, type TrajectorySummary } from "../runs";

/** Saves the model turn its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
export type MarkWrong = (step: number, want: string) => Promise<SessionEval>;

export const laneNames: Record<Lane, string> = {
  asked: t("web.session.trajectory.lane.asked"),
  model: t("web.session.trajectory.lane.model"),
  tool: t("web.session.trajectory.lane.tool"),
};

export type StepFilter = "all" | "tools" | "errors";

export const stepFilters: readonly StepFilter[] = ["all", "tools", "errors"];

export function stepFilterLabel(kind: StepFilter): string {
  switch (kind) {
    case "all":
      return t("web.session.hub.scope.all");
    case "tools":
      return t("web.session.runs.span.tool");
    case "errors":
      return t("web.session.runs.span.error");
  }
}

export function isErrorStep(step: SessionEvent): boolean {
  return step.type === "run/error" || (step.type === "tool/call" && step.ok === false);
}

export function matchesStepFilter(step: SessionEvent, filter: StepFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tools":
      return step.type === "tool/call";
    case "errors":
      return isErrorStep(step);
  }
}

interface TagTone {
  readonly bgClass: string;
  readonly bgStyle?: () => string;
  readonly text: string;
}

/** Semantic pill colors for trajectory step tags: guaranteed contrast in both light and dark modes. */
export function tagToneOf(step: SessionEvent): TagTone {
  switch (step.type) {
    case "user/message":
      return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
    case "memory/recalled":
    case "assistant/message":
      return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
    case "assistant/thinking":
      return { bgClass: "bg-hover", text: "text-muted" };
    case "llm/retry":
    case "permission/request":
    case "interaction/request":
      return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
    case "permission/resolved":
    case "interaction/resolved":
      return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
    case "llm/usage":
      return { bgClass: "bg-hover", text: "text-faint" };
    case "run/error":
      return { bgClass: "bg-bad-soft", text: "text-berry" };
    case "tool/call":
      if (step.ok === false) return { bgClass: "bg-bad-soft", text: "text-berry" };
      if (step.ok === undefined) return { bgClass: "", bgStyle: () => mix("water", 0.14), text: "text-water" };
      switch (step.action ?? "other") {
        case "read_file":
        case "search":
        case "web":
          return { bgClass: "", bgStyle: () => mix("water", 0.14), text: "text-water" };
        case "edit_file":
          return { bgClass: "bg-ok-soft", text: "text-ok-ink" };
        case "wait":
          return { bgClass: "bg-warn-soft", text: "text-warn-ink" };
        case "run_command":
        case "mcp":
        case "other":
          return { bgClass: "bg-hover", text: "text-ink" };
      }
      break;
    case "run/start":
    case "run/end":
    case "tool/result":
      return { bgClass: "bg-hover", text: "text-muted" };
  }
}

export function stepTextOf(step: SessionEvent): string {
  if (step.text) return localizeRuntimeError(step.text).text;
  if (step.type === "llm/usage" && step.tokens) {
    return t("web.session.trajectory.tokens", {
      input: tokensText(Math.round(step.tokens.input + step.tokens.cacheRead)),
      output: tokensText(Math.round(step.tokens.output)),
    });
  }
  return "";
}

export function compactTokenBadge(step: SessionEvent): string | undefined {
  if (!step.tokens) return undefined;
  const totalIn = Math.round(step.tokens.input + step.tokens.cacheRead);
  const totalOut = Math.round(step.tokens.output);
  if (totalIn + totalOut <= 0) return undefined;
  return `${tokensText(totalIn)}/${tokensText(totalOut)}`;
}

export const haystack = (step: SessionEvent, tag: string) =>
  [tag, stepTextOf(step), step.tool ?? "", step.input ?? "", step.output ?? ""].join("\n").toLowerCase();

const MAX_MODEL_STEP_MS = 30 * 60_000;
const LATE_USAGE_GRACE_MS = 30_000;

export interface TrajectoryDurations {
  readonly modelMs: number;
  readonly toolMs: number;
}

/**
 * Computes active model and tool durations for a single run's top-level events,
 * closing turns on new user messages and never attributing inter-turn idle hours,
 * stale unclosed historical spans, or unmatched historical tool calls to model/tool time.
 */
function computeSingleRunDurations(steps: readonly SessionEvent[], live: boolean, endMs: number): TrajectoryDurations {
  let modelMs = 0;
  let toolMs = 0;
  let waiting: number | undefined;
  let openStart: number | undefined;
  let openEnd: number | undefined;
  const openCalls = new Map<number, number>();

  const closeOpen = (at?: number) => {
    if (openStart === undefined) return;
    const stop = at ?? openEnd ?? openStart;
    if (stop > openStart) modelMs += stop - openStart;
    openStart = undefined;
    openEnd = undefined;
  };

  for (const e of steps) {
    if (e.under !== undefined) continue;
    switch (e.type) {
      case "run/start":
        closeOpen();
        waiting = e.time;
        break;
      case "run/end":
        closeOpen();
        waiting = undefined;
        openCalls.clear();
        break;
      case "user/message":
        // Close any lingering model span from the previous turn at its own last activity, never across idle time.
        closeOpen();
        waiting = e.time;
        break;
      case "assistant/thinking":
      case "assistant/message":
      case "tool/call": {
        if (openStart === undefined) {
          const waitGap = waiting !== undefined ? e.time - waiting : -1;
          openStart = waitGap >= 0 && waitGap <= MAX_MODEL_STEP_MS ? waiting! : e.time;
        }
        if (openEnd === undefined || e.time >= openEnd) openEnd = e.time;
        if (e.type === "tool/call") {
          // Once the model hands off to a tool, close the model turn and start timing the tool.
          closeOpen(e.time);
          waiting = undefined;
          openCalls.set(e.seq, e.time);
        }
        break;
      }
      case "llm/usage":
      case "run/error": {
        if (openStart !== undefined) {
          const last = openEnd ?? openStart;
          const stop = e.time >= last && e.time - last <= LATE_USAGE_GRACE_MS ? e.time : last;
          closeOpen(stop);
        }
        waiting = undefined;
        break;
      }
      case "tool/result": {
        closeOpen();
        if (e.call !== undefined) {
          const started = openCalls.get(e.call);
          if (started !== undefined) {
            openCalls.delete(e.call);
            if (e.time > started) toolMs += e.time - started;
          }
        }
        waiting = e.time;
        break;
      }
      case "memory/recalled":
        if (openStart === undefined) waiting = e.time;
        break;
      case "llm/retry":
      case "permission/request":
      case "permission/resolved":
      case "interaction/request":
      case "interaction/resolved":
        break;
    }
  }

  // Close any open model turn at its last observed model event (never stretching a completed reply to `now`).
  closeOpen();

  // Only an actively working run with a pending prompt or in-flight tool call counts live elapsed time up to `endMs`.
  if (live) {
    if (waiting !== undefined && openCalls.size === 0 && endMs > waiting && endMs - waiting <= MAX_MODEL_STEP_MS) {
      modelMs += endMs - waiting;
    }
    for (const started of openCalls.values()) {
      if (endMs > started && endMs - started <= MAX_MODEL_STEP_MS) {
        toolMs += endMs - started;
      }
    }
  }

  return { modelMs, toolMs };
}

/** Aggregates accurate model and tool durations across all runs in a session event log. */
export function computeTrajectoryDurations(steps: readonly SessionEvent[], working: boolean, endMs: number): TrajectoryDurations {
  const runs: SessionEvent[][] = [];
  let prevRun: string | undefined;
  let hasPrev = false;
  for (const e of steps) {
    if (e.under !== undefined) continue;
    if (!hasPrev || e.run !== prevRun) {
      runs.push([e]);
      prevRun = e.run;
      hasPrev = true;
    } else {
      runs.at(-1)?.push(e);
    }
  }
  let modelMs = 0;
  let toolMs = 0;
  for (let i = 0; i < runs.length; i++) {
    const group = runs.at(i);
    if (group === undefined) continue;
    const isLastLive = working && i === runs.length - 1;
    const d = computeSingleRunDurations(group, isLastLive, endMs);
    modelMs += d.modelMs;
    toolMs += d.toolMs;
  }
  return { modelMs, toolMs };
}

/** Active duration for a single RunGroup header without stretching across multi-hour idle gaps. */
export function computeRunDurationMs(steps: readonly SessionEvent[], live: boolean, endMs: number): number {
  const { modelMs, toolMs } = computeSingleRunDurations(steps, live, endMs);
  const active = modelMs + toolMs;
  if (active > 0) return active;
  const first = steps.at(0);
  const last = steps.at(-1);
  if (!first || !last) return 0;
  const stop = live && endMs > last.time ? endMs : last.time;
  const raw = Math.max(0, stop - first.time);
  return raw <= MAX_MODEL_STEP_MS ? raw : 0;
}

/** Replaces inflated server/idle-gap model/tool durations with accurate step-derived durations. */
export function sanitizeTrajectorySummary(base: TrajectorySummary, steps: readonly SessionEvent[], working: boolean, endMs: number): TrajectorySummary {
  if (steps.length === 0) return base;
  const computed = computeTrajectoryDurations(steps, working, endMs);
  const hasModelEvents = steps.some(
    (e) => e.under === undefined && (e.type === "user/message" || e.type === "assistant/thinking" || e.type === "assistant/message" || e.type === "tool/call"),
  );
  const hasToolResults = steps.some((e) => e.under === undefined && e.type === "tool/result");
  const modelMs = hasModelEvents ? computed.modelMs : base.modelMs <= MAX_MODEL_STEP_MS ? base.modelMs : 0;
  const toolMs = hasToolResults || computed.toolMs > 0 ? computed.toolMs : base.toolMs <= MAX_MODEL_STEP_MS ? base.toolMs : 0;
  return {
    ...base,
    modelMs,
    toolMs,
  };
}

export function summaryText(s: TrajectorySummary) {
  const hit = cacheHit(s);
  return [
    t("web.session.trajectory.runs", { n: s.runs }),
    t("web.session.trajectory.steps", { n: s.steps }),
    t("web.session.trajectory.modelTime", { took: secondsText(s.modelMs) }),
    t("web.session.trajectory.toolTime", { took: secondsText(s.toolMs) }),
    ...(hit !== undefined
      ? [
          t("web.session.trajectory.cacheHit", { pct: Math.round(hit * 100) }),
          t("web.session.trajectory.tokens", { input: tokensText(s.input + s.cacheRead), output: tokensText(s.output) }),
        ]
      : []),
  ].join(" · ");
}

export interface RowSpec {
  readonly step: SessionEvent;
  readonly tag: string;
  readonly when: string;
  readonly durationMs: number | undefined;
  readonly readableInput: string | undefined;
  readonly collapsedSummary: string | undefined;
  readonly markable: boolean;
}

export interface RunGroup {
  readonly key: string;
  readonly label: string;
  readonly when: string;
  readonly took: string;
  readonly stepsCount: number;
  readonly toolsCount: number;
  readonly tokens: string | undefined;
  readonly live: boolean;
  readonly hasError: boolean;
  readonly rows: readonly RowSpec[];
}

export const emptySummary: TrajectorySummary = {
  runs: 0,
  steps: 0,
  modelMs: 0,
  toolMs: 0,
  input: 0,
  cacheRead: 0,
  output: 0,
};
