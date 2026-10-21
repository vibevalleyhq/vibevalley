// The one wrapper of TanStack's useQuery (below); the page imports that one.
// oxlint-disable-next-line no-restricted-imports
import { QueryClient, useQuery as tanstackQuery } from "@tanstack/solid-query";
import { untrack } from "solid-js";
import { api } from "./api";

/** REST reads besides the state stream (history, changes, …); a frame that changes what they show invalidates them. */
export const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/**
 * TanStack's useQuery, its fetch run untracked: the options are read in a tracking scope (a key that changes is a new
 * query), and the fetch reads the same props and signals once, when it runs, inside TanStack's own callback. The page
 * imports this one (lint refuses @tanstack/solid-query's).
 */
export const useQuery: typeof tanstackQuery = ((options: Parameters<typeof tanstackQuery>[0], client?: Parameters<typeof tanstackQuery>[1]) =>
  tanstackQuery(() => {
    const o = options();
    const fetch = o.queryFn;
    if (typeof fetch !== "function") return o;
    return { ...o, queryFn: (context: Parameters<typeof fetch>[0]) => untrack(() => fetch(context)) };
  }, client)) as typeof tanstackQuery;

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
