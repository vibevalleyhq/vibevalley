import { createEffect, createMemo, deep } from "solid-js";

import type { IssueHistory } from "@vibevalley/protocol";
import { api } from "./api";
import { useCore } from "./frame";
import { queries, ready, useQuery } from "./query";

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
  const history = useQuery(() => ({ queryKey: ["issues", "history"], queryFn: () => api.issue.history() }));
  // Without 更早的, only the issues the frame still keeps.
  const rows = createMemo<IssueHistory[] | undefined>(() => {
    const all = ready(history, undefined);
    if (!all || older()) return all;
    const kept = new Set((core()?.issues ?? []).map((i) => i.id));
    return all.filter((r) => kept.has(r.issue.id));
  });
  return { rows, loading: () => history.isPending || core() === undefined, error: () => history.error };
}
