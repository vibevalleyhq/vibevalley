import type { JSX } from "@solidjs/web";
import { type Accessor, createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext } from "solid-js";

import { createQueryClient, type QueryClient, type QueryDescriptor, type QueryKey, type QuerySnapshot } from "./cache";

const Context = createContext<QueryClient>();
export const useQueryClient = () => useContext(Context);
export function QueryProvider(props: { client?: QueryClient; children: JSX.Element }) {
  const client = untrack(() => props.client) ?? createQueryClient();
  onCleanup(() => client.dispose());
  return <Context value={client}>{props.children}</Context>;
}
export type QueryResult<T> = {
  snapshot: Accessor<QuerySnapshot<T>>;
  data: Accessor<T | undefined>;
  error: Accessor<Error | undefined>;
  status: Accessor<QuerySnapshot<T>["status"]>;
  fetching: Accessor<boolean>;
  stale: Accessor<boolean>;
  previous: Accessor<{ key: QueryKey; value: T } | undefined>;
  refetch: () => Promise<QuerySnapshot<T>>;
};
export function useQuery<T>(
  descriptor: Accessor<QueryDescriptor<T>>,
  options: { enabled?: Accessor<boolean>; interval?: Accessor<number | false>; keepPrevious?: boolean } = {},
): QueryResult<T> {
  const client = useQueryClient();
  const query = createMemo(descriptor);
  const initial = untrack(query);
  const [observed, setObserved] = createSignal({ key: initial.key, value: client.read(initial) });
  const snapshot = createMemo(() => {
    const next = query();
    const current = observed();
    return JSON.stringify(next.key) === JSON.stringify(current.key) ? current.value : client.read(next);
  });
  const [previous, setPrevious] = createSignal<{ key: QueryKey; value: T }>();
  let bound: { query: QueryDescriptor<T>; subscription: ReturnType<QueryClient["subscribe"]> } | undefined;
  createEffect(
    () => ({ query: query(), enabled: options.enabled?.() ?? true, interval: options.interval?.() ?? false }),
    (next) => {
      client.read(next.query);
      if (bound && JSON.stringify(bound.query.key) === JSON.stringify(next.query.key)) {
        bound.subscription.update(next);
        return;
      }
      if (options.keepPrevious === true && bound) {
        const record = client.read(bound.query).record;
        if (record) setPrevious({ key: bound.query.key, value: record.value });
      }
      bound?.subscription.stop();
      const update = () => setObserved({ key: next.query.key, value: client.read(next.query) });
      bound = { query: next.query, subscription: client.subscribe(next.query, update, next) };
      update();
    },
  );
  onCleanup(() => bound?.subscription.stop());
  const data = createMemo(() => snapshot().record?.value);
  return {
    snapshot,
    data,
    error: () => snapshot().error,
    status: () => snapshot().status,
    fetching: () => snapshot().fetching,
    stale: () => snapshot().stale,
    previous,
    refetch: () => client.refetch(untrack(query)),
  };
}
export const ready = <T, F>(query: Pick<QueryResult<T>, "data">, fallback: F): T | F => query.data() ?? fallback;
