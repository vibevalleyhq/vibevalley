import { createEffect, createMemo, deep } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Issue, type IssueHistory, defaultOrchestrator, type Session, type TaskGraph } from "@vibevalley/protocol";

import { api } from "@/infra/api";
import { useCore, useFrames } from "@/infra/frame";
import { queries, ready, useQuery, useAgents } from "@/infra/query";

import { boardRows, historyKey } from "./rows";

/** Every issue with its real sessions: the frame's issues as the frame has them, the history (issue.history.list) for the
 * sessions that left and, with `older`, the issues the frame no longer keeps (rows.ts). */
export function useIssueHistory(older: () => boolean) {
  const core = useCore();
  // Read again only when what it adds can have changed: a move or an edit is the frame's alone.
  createEffect(
    () => historyKey(core()),
    () => void queries.invalidateQueries({ queryKey: ["issues", "history"] }),
    { defer: true },
  );
  // An issue's changes follow its helper's work, which the frame's issues show; the frames reconcile into a store, so an
  // unchanged frame changes nothing here.
  createEffect(
    () => {
      const issues = core()?.issues;
      return issues ? deep(issues) : undefined;
    },
    () => void queries.invalidateQueries({ queryKey: ["issues", "changes"] }),
    { defer: true },
  );
  const history = useQuery(() => ({ queryKey: ["issues", "history"], queryFn: () => api.issue.history.list() }));
  // A session that left the farm, as the frame last had it, until the history read again has it.
  const seen = new Map<string, Session>();
  const rows = createMemo<IssueHistory[] | undefined>(() => {
    const now = core();
    for (const s of now?.sessions ?? []) seen.set(s.id, s);
    return boardRows(now, ready(history, undefined), older(), seen);
  });
  return { rows, loading: () => history.isPending || core() === undefined, error: () => history.error };
}

// An issue's reads, keyed under "issues".

/** What completing the issue would merge; read only while it is shown. */
export const useIssueChanges = (id: () => string, shown: () => boolean = () => true) =>
  useQuery(() => ({ queryKey: ["issues", "changes", id()], queryFn: () => api.issue.diff.get({ id: id() }), enabled: shown() }));

/** The issue's timeline, read again as it moves on: where it stands, its helper's rounds, the findings it was sent back with. */
export const useIssueTimeline = (issue: () => Issue, rounds: () => number) =>
  useQuery(() => ({
    queryKey: ["issues", "timeline", issue().id, issue().attention.state, rounds(), issue().findings.length],
    queryFn: () => api.issue.timeline.get({ id: issue().id }),
    placeholderData: <T>(prev: T) => prev,
  }));

/** The issue's runs, read again whenever version changes. */
export const useIssueRuns = (id: () => string, version: () => string) =>
  useQuery(() => ({
    queryKey: ["issues", "runs", id(), version()],
    queryFn: () => api.issue.run.list({ id: id() }),
    placeholderData: <T>(prev: T) => prev,
  }));

const noGraphs: TaskGraph[] = [];

export function useGraphs(): () => TaskGraph[] {
  const frames = useFrames();
  return () => frames.frame?.graphs ?? noGraphs;
}

export function useNameOf(): () => (id: string) => string {
  const agents = useAgents();
  return createMemo(() => {
    const all = ready(agents, []);
    return (id: string) => all.find((a) => a.id === id)?.name || (id === defaultOrchestrator ? t("web.issue.orchestrator") : id);
  });
}
