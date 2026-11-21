// VibeValley's infra/query/solid.tsx on nsh: the same exports. The query
// cache itself (cache.ts) is VibeValley's, vendored as it is.
import { cleanup, computed, context, signal, untracked, type Accessor, type JSX } from "nsh";

import { createEffect } from "../solid";
import { createQueryClient, type QueryClient, type QueryDescriptor, type QueryKey, type QuerySnapshot } from "./cache";

const Context = context<QueryClient | undefined>(undefined);
let fallback: QueryClient | undefined;
/** The client of the nearest QueryProvider, else one for the whole app. */
export const useQueryClient = (): QueryClient => Context() ?? (fallback ??= createQueryClient());
export function QueryProvider(props: { client?: QueryClient; children: JSX.Element }) {
  const client = untracked(() => props.client) ?? createQueryClient();
  cleanup(() => client.dispose());
  return <Context.Provider value={client}>{props.children}</Context.Provider>;
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
  const query = computed(descriptor);
  const initial = untracked(query);
  const observed = signal({ key: initial.key, value: client.read(initial) });
  const snapshot = computed(() => {
    const next = query();
    const current = observed();
    return JSON.stringify(next.key) === JSON.stringify(current.key) ? current.value : client.read(next);
  });
  const previous = signal<{ key: QueryKey; value: T } | undefined>(undefined);
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
        if (record) previous.set({ key: bound.query.key, value: record.value });
      }
      bound?.subscription.stop();
      const update = () => observed.set({ key: next.query.key, value: client.read(next.query) });
      bound = { query: next.query, subscription: client.subscribe(next.query, update, next) };
      update();
    },
  );
  cleanup(() => bound?.subscription.stop());
  const data = computed(() => snapshot().record?.value);
  return {
    snapshot,
    data,
    error: () => snapshot().error,
    status: () => snapshot().status,
    fetching: () => snapshot().fetching,
    stale: () => snapshot().stale,
    previous: () => previous(),
    refetch: () => client.refetch(untracked(query)),
  };
}
export const ready = <T, F>(query: Pick<QueryResult<T>, "data">, fallback: F): T | F => query.data() ?? fallback;
