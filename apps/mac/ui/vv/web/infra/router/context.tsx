import { context, untracked, type Accessor, type JSX } from "nsh";

import { createMemo } from "../../../solid";
import { createExternal } from "../../base/external";
import { memoryHistory, type Location, type Navigation, type RouterHistory, type SearchUpdate, updateSearch } from "./history";
import type { RoutePath } from "./matching";
import type { SearchDefinition } from "./search";

export interface RouterController {
  readonly path: Accessor<string>;
  readonly location: Accessor<Location>;
  readonly history: RouterHistory;
  readonly navigate: RouterHistory["navigate"];
}

const RouterContext = context<RouterController | undefined>(undefined);

/** The one history of the app's page, for code outside the tree (the host's "open this route"). */
export const appHistory: RouterHistory = memoryHistory("/");

export function useRouter(): RouterController {
  const router = RouterContext();
  if (!router) throw new Error("useRouter outside a Router");
  return router;
}

export function Router(props: { history?: RouterHistory; children: JSX.Element }) {
  const history = untracked(() => props.history) ?? appHistory;
  const location = createExternal(history.subscribe, history.read);
  const path = createMemo(() => location().pathname + location().search);
  const controller: RouterController = { path, location, history, navigate: history.navigate };
  return <RouterContext.Provider value={controller}>{props.children}</RouterContext.Provider>;
}

export const useLocation = (): Accessor<Location> => useRouter().location;

export function useParams<const P extends string, T extends object>(definition: RoutePath<P, T>): Accessor<T> {
  const location = useLocation();
  const initial = untracked(() => definition.match(location().pathname));
  if (!initial) throw new Error(`Route parameters read outside their route: ${definition.path}`);
  return createMemo(() => definition.match(location().pathname) ?? initial);
}

export function useSearchValues<T>(definition: SearchDefinition<T>): [Accessor<T>, (update: (current: T) => T, options?: Navigation) => void] {
  const router = useRouter();
  const initial = untracked(() => definition.read(router.location().search));
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
