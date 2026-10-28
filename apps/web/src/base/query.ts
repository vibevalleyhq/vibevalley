// QueryObserver owns cache, fetching and retry policy; this adapter publishes its settled snapshots without suspending
// the state stream's updates while a REST read is in flight.
import { QueryClient, QueryObserver, type QueryKey, type QueryObserverOptions, type QueryObserverResult } from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onSettled, untrack } from "solid-js";
import { api } from "./api";

/** REST reads besides the state stream (history, changes, …); a frame that changes what they show invalidates them. */
export const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/** REST reads never hold the state stream's frame: pending and failures are result values, and ready() selects data. */
export function useQuery<TQueryFnData, TError = Error, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: Accessor<QueryObserverOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>>,
  client: Accessor<QueryClient> = () => queries,
): QueryObserverResult<TData, TError> {
  const optionsNow = () => {
    const o = options();
    const fetch = o.queryFn;
    if (typeof fetch !== "function") return o;
    return { ...o, queryFn: (context: Parameters<typeof fetch>[0]) => untrack(() => fetch(context)) };
  };
  const observer = new QueryObserver(untrack(client), untrack(optionsNow));
  const [result, setResult] = createSignal(observer.getCurrentResult());
  createEffect(optionsNow, (next) => {
    observer.setOptions(next);
    setResult(observer.getCurrentResult());
  });
  onSettled(() => {
    const stop = observer.subscribe(setResult);
    setResult(observer.getCurrentResult());
    return () => {
      stop();
      observer.destroy();
    };
  });
  return new Proxy(observer.getCurrentResult(), {
    get: (_, key) => result()[key as keyof ReturnType<typeof observer.getCurrentResult>],
  });
}

/**
 * A query's successful data once it has arrived, else `fallback` (including disabled and failed queries).
 */
export const ready = <T, F>(q: { readonly isSuccess: boolean; readonly data: T | undefined }, fallback: F): T | F =>
  q.isSuccess && q.data !== undefined ? q.data : fallback;

export type Sprites = Record<string, { w: number; h: number; ax?: number; ay?: number }>;

export const useSprites = () =>
  useQuery(() => ({
    queryKey: ["sprites"],
    queryFn: async () => (await (await fetch("/pixel/sprites.json")).json()) as Sprites,
    staleTime: Infinity,
  }));

/** Every profile, the orchestrator's too. */
export const useAgents = () => useQuery(() => ({ queryKey: ["agents"], queryFn: () => api.agent.list() }));

/** The templates a profile installs from: the built-in ones, then those added on this machine. */
export const useAgentTemplates = () => useQuery(() => ({ queryKey: ["agent-templates"], queryFn: () => api.agent.template.list() }));

export const useProjects = () => useQuery(() => ({ queryKey: ["projects"], queryFn: () => api.project.list(), refetchInterval: 30_000 }));

export const useSettings = () => useQuery(() => ({ queryKey: ["settings"], queryFn: () => api.setting.get() }));

/** The runtimes on this machine; probed again every few minutes on the server. */
export const useRuntimes = () => useQuery(() => ({ queryKey: ["runtimes"], queryFn: () => api.runtime.list(), refetchInterval: 60_000 }));
