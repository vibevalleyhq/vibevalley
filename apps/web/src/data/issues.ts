import { createEffect, createMemo } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import type { IssueHistory } from "@vibevalley/protocol";
import { api } from "./api";
import { useCore } from "./frame";
import { ready, queries } from "./query";

/** Every issue with its real sessions (issue.history), read again whenever the frame's issues change. */
export function useIssueHistory(older: () => boolean) {
  const core = useCore();
  createEffect(
    () => JSON.stringify(core()?.issues ?? null),
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
