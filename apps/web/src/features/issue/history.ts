import { Schema } from "effect";
import { createEffect, createMemo, deep } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Issue, type IssueHistory, defaultOrchestrator, type Session } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineQuery, retryRead, useQueryClient, ready, useQuery, useAgents } from "#/infra/query.ts";

import { boardRows, historyKey } from "./cards";

/** Every issue with its real sessions: the frame's issues as the frame has them, the history (issue.history.list) for the sessions that left and, with `older`, the issues the frame no longer keeps (rows.ts). */
const historyQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.IssueHistory)),
  key: () => ["issues", "history"],
  fetch: (_: void, context) => api.issue.history.list(context),
  ...retryRead,
});
const changesQuery = defineQuery({
  schema: S.Changes,
  key: (id: string) => ["issues", "changes", id],
  fetch: (id, context) => api.issue.diff.get({ id }, context),
  ...retryRead,
});
const timelineQuery = defineQuery({
  schema: S.IssueTimeline,
  key: (a: { id: string; state: string; rounds: number; findings: number }) => ["issues", "timeline", a.id, a.state, a.rounds, a.findings],
  fetch: (a, context) => api.issue.timeline.get({ id: a.id }, context),
  ...retryRead,
});
const runsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Run)),
  key: (a: { id: string; version: string }) => ["issues", "runs", a.id, a.version],
  fetch: (a, context) => api.issue.run.list({ id: a.id }, context),
  ...retryRead,
});

export function useIssueHistory(older: () => boolean) {
  const queries = useQueryClient();
  const core = useCore();
  // Read again only when what it adds can have changed: a move or an edit is the frame's alone.
  createEffect(
    () => historyKey(core()),
    () => void queries.invalidate({ prefix: ["issues", "history"] }),
    { defer: true },
  );
  // An issue's changes follow its helper's work, which the frame's issues show; the frames reconcile into a store, so an
  // unchanged frame changes nothing here.
  createEffect(
    () => {
      const issues = core()?.issues;
      return issues ? deep(issues) : undefined;
    },
    () => void queries.invalidate({ prefix: ["issues", "changes"] }),
    { defer: true },
  );
  const history = useQuery(historyQuery);
  // A session that left the farm, as the frame last had it, until the history read again has it.
  const seen = new Map<string, Session>();
  const rows = createMemo<IssueHistory[] | undefined>(() => {
    const now = core();
    for (const s of now?.sessions ?? []) seen.set(s.id, s);
    return boardRows(now, ready(history, undefined), older(), seen);
  });
  return { rows, loading: () => history.status() === "pending" || core() === undefined, error: history.error };
}

// An issue's reads, keyed under "issues".

/** What completing the issue would merge; read only while it is shown. */
export const useIssueChanges = (id: () => string, shown: () => boolean = () => true) => useQuery(() => changesQuery(id()), { enabled: shown });

/** The issue's timeline, read again as it moves on: where it stands, its helper's rounds, the findings it was sent back with. */
export const useIssueTimeline = (issue: () => Issue, rounds: () => number) =>
  useQuery(() => timelineQuery({ id: issue().id, state: issue().stage.state, rounds: rounds(), findings: issue().findings.length }), { keepPrevious: true });

/** The issue's runs, read again whenever version changes. */
export const useIssueRuns = (id: () => string, version: () => string) => useQuery(() => runsQuery({ id: id(), version: version() }), { keepPrevious: true });

const noIssues: Issue[] = [];

export function useIssues(): () => Issue[] {
  const core = useCore();
  return () => core()?.issues ?? noIssues;
}

export function useNameOf(): () => (id: string) => string {
  const agents = useAgents();
  return createMemo(() => {
    const all = ready(agents, []);
    return (id: string) => all.find((a) => a.id === id)?.name || (id === defaultOrchestrator ? t("web.issue.orchestrator") : id);
  });
}
