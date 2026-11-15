import type { JSX } from "@solidjs/web";
import { Loading, onSettled, untrack } from "solid-js";

import { createFrames, FramesContext, type FramesSource } from "#/infra/frame.ts";
import { reveal } from "#/infra/opening.ts";
import { QueryProvider, refetchOnRelink, useQueryClient } from "#/infra/query.ts";
import { Router } from "#/infra/router.ts";
import { framesIn, type Registry, RegistryContext, subscribeFrames, useRegistry } from "#/state/atom.ts";

function registryFramesSource(registry: Registry): FramesSource {
  return {
    get: () => framesIn(registry),
    subscribe: (listener) => subscribeFrames(registry, () => listener()),
  };
}

/** What every page has around it: the router, the atoms' registry (intents, the page's own values), the state frames,
 * the query cache. */
export function Root(props: { registry?: Registry; children: JSX.Element }) {
  const registry = untrack(() => props.registry) ?? useRegistry();
  return (
    <Router>
      <RegistryContext value={registry}>
        <FramesScope>
          <QueryProvider>
            {/* A read nobody guarded with ready() waits here rather than leaving the page blank forever. */}
            <Loading>
              <Opened />
              {props.children}
            </Loading>
          </QueryProvider>
        </FramesScope>
      </RegistryContext>
    </Router>
  );
}

function FramesScope(props: { children: JSX.Element }) {
  const store = createFrames(registryFramesSource(useRegistry()));
  return <FramesContext value={store}>{props.children}</FramesContext>;
}

/** The page is up: the cover index.html started on (public/opening.html) goes once the page is ready (infra/opening.ts). */
function Opened() {
  const queries = useQueryClient();
  const source = registryFramesSource(useRegistry());
  onSettled(() => {
    const stop = new AbortController();
    void reveal(queries, stop.signal);
    const unsubscribe = refetchOnRelink(source, queries);
    return () => {
      stop.abort();
      unsubscribe();
    };
  });
  return null;
}
