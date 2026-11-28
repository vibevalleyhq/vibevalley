import type { JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionEval, SessionEvent, Spent } from "@vibevalley/protocol";
import { oneLine, sessionRepo } from "@vibevalley/protocol/rules";

import type { DotTone } from "../../../design/Tag";
import { mix } from "../../../design/tone";
import { api } from "../../../infra/api";
import { ago, yuan } from "../../../infra/base/format";
import { defineQuery, retryRead } from "../../../infra/query";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { formatTokens } from "../../../infra/sessionRuns";
import { runActivityAt, type RunEntry, type RunsScope, type RunStatusBadge } from "../runsView";

/** Provided by app/: orchestrator links to runs, so session does not import orchestrator back. */
export type RunApprovals = (props: { readonly id: string }) => JSX.Element;

export const markWrongOf =
  (id: string) =>
  (on: number, want: string): Promise<SessionEval> =>
    api.session.eval.create({ id, on, want });

export const allSessionsQuery = defineQuery({
  key: () => ["sessions", "all"],
  fetch: (_: void, context) => api.session.list({}, context),
  ...retryRead,
});

export function scopeLabel(scope: RunsScope): string {
  switch (scope) {
    case "all":
      return t("web.session.hub.scope.all");
    case "active":
      return t("web.session.hub.scope.active");
    case "orchestrator":
      return t("web.session.hub.scope.orchestrator");
    case "worker":
      return t("web.session.hub.scope.worker");
  }
}

interface StatusPresentation {
  readonly label: string;
  readonly dot: DotTone;
  readonly pillClass: string;
  readonly pillBg?: () => string;
  readonly textClass: string;
}

export function statusMeta(status: RunStatusBadge): StatusPresentation {
  switch (status) {
    case "working":
      return {
        label: t("web.session.hub.status.working"),
        dot: "water",
        pillClass: "",
        pillBg: () => mix("water", 0.14),
        textClass: "text-water",
      };
    case "listening":
      return {
        label: t("web.session.hub.status.listening"),
        dot: "leaf",
        pillClass: "bg-ok-soft",
        textClass: "text-ok-ink",
      };
    case "resting":
      return {
        label: t("web.session.hub.status.resting"),
        dot: "wheat",
        pillClass: "bg-warn-soft",
        textClass: "text-warn-ink",
      };
    case "done":
      return {
        label: t("web.session.hub.status.done"),
        dot: "leaf",
        pillClass: "bg-ok-soft",
        textClass: "text-ok-ink",
      };
    case "failed":
      return {
        label: t("web.session.hub.status.failed"),
        dot: "berry",
        pillClass: "bg-bad-soft",
        textClass: "text-berry",
      };
    case "interrupted":
      return {
        label: t("web.session.hub.status.interrupted"),
        dot: "wheat",
        pillClass: "bg-warn-soft",
        textClass: "text-warn-ink",
      };
    case "closed":
      return {
        label: t("web.session.hub.status.closed"),
        dot: "idle",
        pillClass: "bg-hover",
        textClass: "text-muted",
      };
  }
}

export function entryName(entry: RunEntry): string {
  switch (entry.kind) {
    case "orchestrator":
      return entry.agent.name;
    case "worker":
      return entry.live?.name ?? entry.session.name;
  }
}

export function entrySubtitle(entry: RunEntry): string {
  switch (entry.kind) {
    case "orchestrator":
      return (entry.live?.phaseText ? localizeRuntimeError(entry.live.phaseText).text : "") || entry.agent.duty || t("web.agent.list.orchestratorLine");
    case "worker":
      if (entry.issue) return entry.issue.title;
      return oneLine(entry.session.brief).trim() || sessionRepo(entry.session) || "";
  }
}

export function entryTiming(entry: RunEntry, now: number): string {
  switch (entry.kind) {
    case "orchestrator": {
      const at = runActivityAt(entry);
      return at > 0 ? ago(at, now) : "";
    }
    case "worker": {
      const phase = entry.live?.phase ?? entry.session.phase;
      if (phase._tag === "closed") {
        return t("web.session.trajectory.hiredAndLeft", { hired: ago(entry.session.hiredAt, now), left: ago(phase.at, now) });
      }
      return t("web.session.trajectory.hired", { ago: ago(entry.session.hiredAt, now) });
    }
  }
}

export function formatCompactSpend(spent: Spent): string {
  const tokens = formatTokens(spent.tokens);
  return spent.cny !== undefined ? `${yuan(spent.cny)} · ${tokens}` : tokens;
}

export function saturationTone(pct: number): { readonly bar: string; readonly text: string } {
  if (pct >= 85) return { bar: "bg-berry", text: "text-berry" };
  if (pct >= 65) return { bar: "bg-wheat", text: "text-warn-ink" };
  return { bar: "bg-leaf", text: "text-muted" };
}

export function lastUserPromptOf(steps: readonly SessionEvent[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s !== undefined && s.type === "user/message" && s.under === undefined && s.text.trim().length > 0) {
      return s.text.trim();
    }
  }
  return undefined;
}
