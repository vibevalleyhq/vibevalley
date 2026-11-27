import { t } from "@vibevalley/i18n";
import { type Issue, type IssueHistory, defaultOrchestrator, type Session } from "@vibevalley/protocol";

import { api } from "../../../infra/api";
import { useBoardSlice, useSessionsSlice } from "../../../infra/frame";
import { defineQuery, retryRead, useQueryClient, ready, useQuery, useAgents } from "../../../infra/query";
import { createEffect, createMemo, deep } from "../../../infra/solid";
import { boardRows, historyKey } from "./cards";

/** Every issue with its real sessions: the frame's issues as the frame has them, the history (issue.history.list) for the sessions that left and, with `older`, the issues the frame no longer keeps (rows.ts). */
const historyQuery = defineQuery({
  key: () => ["issues", "history"],
  fetch: (_: void, context) => api.issue.history.list(context),
  ...retryRead,
});
const timelineQuery = defineQuery({
  key: (a: { id: string; state: string; rounds: number; findings: number }) => ["issues", "timeline", a.id, a.state, a.rounds, a.findings],
  fetch: (a, context) => api.issue.timeline.get({ id: a.id }, context),
  ...retryRead,
});
const runsQuery = defineQuery({
  key: (a: { id: string; version: string }) => ["issues", "runs", a.id, a.version],
  fetch: (a, context) => api.issue.run.list({ id: a.id }, context),
  ...retryRead,
});

export function useIssueHistory(older: () => boolean) {
  const queries = useQueryClient();
  const board = useBoardSlice();
  const sessionsSlice = useSessionsSlice();
  // Read again only when what it adds can have changed: a move or an edit is the board slice's alone.
  createEffect(
    () => historyKey(board(), sessionsSlice()?.sessions),
    () => void queries.invalidate({ prefix: ["issues", "history"] }),
    { defer: true },
  );
  // An issue's changes follow its helper's work, which the board slice's issues show.
  createEffect(
    () => {
      const issues = board()?.issues;
      return issues ? deep(issues) : undefined;
    },
    () => void queries.invalidate({ prefix: ["issues", "changes"] }),
    { defer: true },
  );
  const history = useQuery(historyQuery);
  // A session that left the farm, as last seen, until the history read again has it.
  const seen = new Map<string, Session>();
  const rows = createMemo<IssueHistory[] | undefined>(() => {
    const b = board();
    const s = sessionsSlice()?.sessions;
    for (const session of s ?? []) seen.set(session.id, session);
    return boardRows(b, s, ready(history, undefined), older(), seen);
  });
  return { rows, loading: () => history.status() === "pending" || board() === undefined, error: history.error };
}

// An issue's reads, keyed under "issues".

/** The issue's timeline, read again as it moves on: where it stands, its helper's rounds, the findings it was sent back with. */
export const useIssueTimeline = (issue: () => Issue, rounds: () => number, enabled: () => boolean = () => true) =>
  useQuery(() => timelineQuery({ id: issue().id, state: issue().stage.state, rounds: rounds(), findings: issue().findings.length }), {
    keepPrevious: true,
    enabled,
  });

/** The issue's runs, read again whenever version changes. */
export const useIssueRuns = (id: () => string, version: () => string) => useQuery(() => runsQuery({ id: id(), version: version() }), { keepPrevious: true });

const noIssues: Issue[] = [];

export function useIssues(): () => Issue[] {
  const board = useBoardSlice();
  return () => board()?.issues ?? noIssues;
}

export function useNameOf(): () => (id: string) => string {
  const agents = useAgents();
  return createMemo(() => {
    const all = ready(agents, []);
    return (id: string) => all.find((a) => a.id === id)?.name || (id === defaultOrchestrator ? t("web.issue.orchestrator") : id);
  });
}
