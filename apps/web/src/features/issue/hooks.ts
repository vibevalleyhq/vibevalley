import { issuesWording } from "./words";
import { createMemo } from "solid-js";
import { defaultOrchestrator, type TaskGraph } from "@vibevalley/protocol";
import { reasonOf } from "../../base/api";
import { toast } from "../../ui/toasts";
import { useFrames } from "../../base/frame";
import { ready, queries, useAgents } from "../../base/query";

const noGraphs: TaskGraph[] = [];

export function useGraphs(): () => TaskGraph[] {
  const frames = useFrames();
  return () => frames.frame?.graphs ?? noGraphs;
}

/** A profile's name by its id; the orchestrator is 管家, a profile gone is its id. */
export function useNameOf(): () => (id: string) => string {
  const agents = useAgents();
  return createMemo(() => {
    const all = ready(agents, []);
    return (id: string) => (id === defaultOrchestrator ? issuesWording().orchestrator : (all.find((a) => a.id === id)?.name ?? id));
  });
}

export const reloadIssues = () => queries.invalidateQueries({ queryKey: ["issues"] });

/** Runs a call; a refusal is said in a toast and the result is undefined. The board is read again after either. */
export async function run<T>(act: () => Promise<T>): Promise<T | undefined> {
  try {
    return await act();
  } catch (e) {
    toast(reasonOf(e), "bad");
    return undefined;
  } finally {
    void reloadIssues();
  }
}
