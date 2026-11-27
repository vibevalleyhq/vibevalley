import { t } from "@vibevalley/i18n";
import type { OrchestratorEval, SessionEvent } from "@vibevalley/protocol";

import { mix } from "../../../design/tone";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { cacheHit, type Lane, secondsText, tokensText, type TrajectorySummary } from "../runs";

/** Saves the model turn its user/message `step` began as a case of the orchestrator's evals; `want` is what it should have done. */
export type MarkWrong = (step: number, want: string) => Promise<OrchestratorEval>;

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
