import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** The projects in the work root (project.list), keyed ["projects"]: making one invalidates it. Asked again every 30 s,
 * as which projects there are comes only by asking. */
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.project.list(), refetchInterval: 30_000 });

export const useProjectNames = () => (useProjects().data ?? []).map((p) => p.name);
