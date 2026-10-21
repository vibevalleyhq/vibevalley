import { QueryClient, useQuery } from "@tanstack/solid-query";
import { api } from "./api";

/** REST reads besides the state stream (history, changes, …); a frame that changes what they show invalidates them. */
export const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/**
 * A query's data once it has arrived, else `fallback`. Reading `data` itself before then suspends into the nearest
 * <Loading> (and a disabled query's never arrives): ready() gives "nothing yet" instead.
 */
export const ready = <T, F>(q: { readonly isSuccess: boolean; readonly data: T }, fallback: F): T | F => (q.isSuccess ? q.data : fallback);

export type Sprites = Record<string, { w: number; h: number; ax?: number; ay?: number }>;

export const useSprites = () =>
  useQuery(() => ({
    queryKey: ["sprites"],
    queryFn: async () => (await (await fetch("/pixel/sprites.json")).json()) as Sprites,
    staleTime: Infinity,
  }));

/** Every profile, the manager's too. */
export const useAgents = () => useQuery(() => ({ queryKey: ["agents"], queryFn: () => api.agent.list() }));

export const useProjects = () => useQuery(() => ({ queryKey: ["projects"], queryFn: () => api.project.list(), refetchInterval: 30_000 }));

export const useSettings = () => useQuery(() => ({ queryKey: ["settings"], queryFn: () => api.setting.load() }));

/** The runtimes on this machine; probed again every few minutes on the server. */
export const useRuntimes = () => useQuery(() => ({ queryKey: ["runtimes"], queryFn: () => api.runtime.list(), refetchInterval: 60_000 }));
