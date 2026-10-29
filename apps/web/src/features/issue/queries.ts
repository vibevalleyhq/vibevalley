import { createEffect, createMemo, deep } from "solid-js";
import { type Issue, type IssueHistory, defaultOrchestrator, type TaskGraph } from "@vibevalley/protocol";
import { api } from "@/base/api";
import { useCore, useFrames } from "@/base/frame";
import { queries, ready, useQuery, useAgents } from "@/base/query";
import { t } from "@vibevalley/i18n";

/** Every issue with its real sessions (issue.history), read again whenever the frame's issues change. */
export function useIssueHistory(older: () => boolean) {
  const core = useCore();
  // Any change inside them: the frames reconcile into a store, so an unchanged frame changes nothing here.
  createEffect(
    () => {
      const issues = core()?.issues;
      return issues ? deep(issues) : undefined;
    },
    () => void queries.invalidateQueries({ queryKey: ["issues"] }),
    { defer: true },
  );
  const history = useQuery(() => ({ queryKey: ["issues", "history"], queryFn: () => api.issue.history.list() }));
  // Without 更早的, only the issues the frame still keeps.
  const rows = createMemo<IssueHistory[] | undefined>(() => {
    const all = ready(history, undefined);
    if (!all || older()) return all;
    const kept = new Set((core()?.issues ?? []).map((i) => i.id));
    return all.filter((r) => kept.has(r.issue.id));
  });
  return { rows, loading: () => history.isPending || core() === undefined, error: () => history.error };
}

// An issue's reads, keyed under "issues" so that whatever reloads the issues reads them again too.

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

export const reloadIssues = () => queries.invalidateQueries({ queryKey: ["issues"] });
