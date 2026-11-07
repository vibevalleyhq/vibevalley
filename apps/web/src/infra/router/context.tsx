import type { JSX } from "@solidjs/web";
import { type Accessor, createContext, createMemo, onSettled, untrack, useContext } from "solid-js";

import { createExternal } from "#/base/external.ts";

import { browserHistory, type Location, type Navigation, type RouterHistory, type SearchUpdate, updateSearch } from "./history";
import { pathSegments, type RoutePath } from "./matching";
import type { SearchDefinition } from "./search";

export interface RouterController {
  readonly path: Accessor<string>;
  readonly location: Accessor<Location>;
  readonly history: RouterHistory;
  readonly navigate: RouterHistory["navigate"];
}

const RouterContext = createContext<RouterController>();

export function useRouter(): RouterController {
  return useContext(RouterContext);
}

export function Router(props: { history?: RouterHistory; children: JSX.Element }) {
  const history = untrack(() => props.history) ?? browserHistory(window);
  const location = createExternal(history.subscribe, history.read);
  const path = createMemo(() => location().pathname + location().search);
  const controller: RouterController = { path, location, history, navigate: history.navigate };
  onSettled(() => {
    const anchor = () => {
      const hash = history.read().hash;
      if (!hash) return;
      const id = pathSegments(hash.slice(1))?.join("/");
      if (id) document.getElementById(id)?.scrollIntoView();
    };
    const moved = () => onSettled(anchor);
    anchor();
    return history.subscribe(moved);
  });
  return <RouterContext value={controller}>{props.children}</RouterContext>;
}

export const useLocation = (): Accessor<Location> => useRouter().location;

export function useParams<const P extends string, T extends object>(definition: RoutePath<P, T>): Accessor<T> {
  const location = useLocation();
  const initial = untrack(() => definition.match(location().pathname));
  if (!initial) throw new Error(`Route parameters read outside their route: ${definition.path}`);
  // A leaving page may finish a computation before its owner is disposed.
  const params = createMemo(() => definition.match(location().pathname) ?? initial);
  return params;
}

export function useSearchValues<T>(definition: SearchDefinition<T>): [Accessor<T>, (update: (current: T) => T, options?: Navigation) => void] {
  const router = useRouter();
  const initial = untrack(() => definition.read(router.location().search));
  if (initial === undefined) throw new Error("Search values read outside a valid route");
  const value = createMemo(() => definition.read(router.location().search) ?? initial);
  return [
    value,
    (update, options) => {
      const location = router.history.read();
      const current = definition.read(location.search);
      if (current === undefined) throw new Error("Cannot update invalid search values");
      router.navigate(definition.write(location, update(current)), options);
    },
  ];
}

export function useSearch(): Accessor<URLSearchParams> {
  const location = useLocation();
  return () => new URLSearchParams(location().search);
}

export function useSearchParams(): [Accessor<URLSearchParams>, (update: SearchUpdate, options?: Navigation) => void] {
  const router = useRouter();
  return [useSearch(), (update, options) => router.navigate(updateSearch(router.history.read(), update), options)];
}
