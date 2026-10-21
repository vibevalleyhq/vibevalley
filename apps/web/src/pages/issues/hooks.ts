import { managerAgent, type TaskGraph } from "@vibevalley/protocol";
import { useCallback } from "react";
import { useAgents } from "../../data/agents";
import { useFrames } from "../../data/frame";

const noGraphs: TaskGraph[] = [];

export const useGraphs = () => useFrames().frame?.graphs ?? noGraphs;

/** A profile's name by its id; the manager is 管家, a profile gone is its id. */
export function useNameOf() {
  const agents = useAgents().data;
  return useCallback((id: string) => (id === managerAgent ? "管家" : (agents?.find((a) => a.id === id)?.name ?? id)), [agents]);
}
