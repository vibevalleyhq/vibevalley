// The page's router: the path is a signal over the browser's history, and moving pushes (or replaces) an entry. The
// routes are matched in app/App.tsx.

import { type Accessor, createContext, createSignal, onSettled, useContext } from "solid-js";

export interface Router {
  /** The path and search the page is at. */
  readonly path: Accessor<string>;
  readonly navigate: (to: string, options?: { replace?: boolean }) => void;
}

export const RouterContext = createContext<Router>();
export const useRouter = () => useContext(RouterContext);

const here = () => location.pathname + location.search;

export function createRouter(): Router {
  const [path, setPath] = createSignal(here());
  onSettled(() => {
    // Back and forward.
    const moved = () => setPath(here());
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  });
  return {
    path,
    navigate: (to, options) => {
      if (options?.replace === true) history.replaceState(null, "", to);
      else if (to !== here()) history.pushState(null, "", to);
      setPath(here());
    },
  };
}

/** The query string of the path the page is at, read again when it moves. */
export function useSearch(): Accessor<URLSearchParams> {
  const router = useRouter();
  return () => new URLSearchParams(router.path().split("?")[1] ?? "");
}
