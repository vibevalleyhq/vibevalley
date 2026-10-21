import { useQuery } from "@tanstack/react-query";
import { type Issue, type IssueHistory, VibeValleyApiError } from "@vibevalley/protocol";
import { useCallback, useEffect, useMemo } from "react";
import { api, queries, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { newIssueTitle } from "../../rules/issues";
import { useToast } from "../../ui/Toast";

/** Every issue with its real sessions (issue.history), read again whenever the frame's issues change. */
export function useIssueHistory(older: boolean) {
  const core = useCore();
  const signature = useMemo(() => JSON.stringify(core?.issues ?? null), [core?.issues]);
  useEffect(() => {
    void queries.invalidateQueries({ queryKey: ["issues"] });
  }, [signature]);
  const history = useQuery({ queryKey: ["issues", "history"], queryFn: () => api.issue.history() });
  // Without 更早的, only the issues the frame still keeps.
  const rows = useMemo<IssueHistory[] | undefined>(() => {
    if (!history.data || older) return history.data;
    const kept = new Set((core?.issues ?? []).map((i) => i.id));
    return history.data.filter((r) => kept.has(r.issue.id));
  }, [history.data, older, core?.issues]);
  return { rows, loading: history.isPending || core === undefined, error: history.error };
}

export const reloadIssues = () => queries.invalidateQueries({ queryKey: ["issues"] });

export { useProjectNames } from "../../data/projects";

/** Runs a call; a refusal is said in a toast and the result is undefined. The board is read again after either. */
export function useRun() {
  const toast = useToast();
  return useCallback(
    async <T>(act: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await act();
      } catch (e) {
        toast(reasonOf(e), "bad");
        return undefined;
      } finally {
        void reloadIssues();
      }
    },
    [toast],
  );
}

const pickKey = "vibevalley.board.pick";

/** The helper and project last picked on this machine, for the next quick add. */
export function rememberedPick(): { agent: string; project: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(pickKey) ?? "null") as unknown;
    if (Array.isArray(raw) && raw.length === 2) return { agent: String(raw[0]), project: String(raw[1]) };
  } catch {
    // No storage: nothing remembered.
  }
  return { agent: "", project: "" };
}

export function rememberPick(agent: string, project: string) {
  if (!agent && !project) return;
  try {
    localStorage.setItem(pickKey, JSON.stringify([agent, project]));
  } catch {
    // The issue is saved already; remembering is best-effort.
  }
}

/** The plus: an issue made at once in the backlog. With words, they are its title and its draft starts from them; the
 * issue is made even when the server refuses the draft, and `refused` says why. */
export async function writeIssue(text: string, agent: string, project: string): Promise<{ issue: Issue; refused: string }> {
  const last = rememberedPick();
  const who = agent || last.agent;
  const where = project || last.project;
  const words = text.trim();
  const made = await api.issue.create({ body: { title: words || newIssueTitle, project: where || undefined, assignee: who || undefined } });
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.draft({ id: made.id, body: { text: words } }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}

/** A key for one sent word, so a retry is not said twice. */
export const newSendKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
