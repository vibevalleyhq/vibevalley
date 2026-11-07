import type { JSX } from "@solidjs/web";
import { Loading, onSettled } from "solid-js";

import { createFrames, frames, FramesContext } from "#/infra/frame.ts";
import { reveal } from "#/infra/opening.ts";
import { QueryProvider, useQueryClient, refetchOnRelink } from "#/infra/query.ts";
import { Router } from "#/infra/router.ts";
import { pageRegistry, RegistryContext } from "#/state/atom.ts";

/** What every page has around it: the router, the state frames, the atoms' registry (intents, the page's own values),
 * the query cache. */
export function Root(props: { children: JSX.Element }) {
  return (
    <Router>
      <FramesContext value={createFrames()}>
        <RegistryContext value={pageRegistry}>
          <QueryProvider>
            {/* A read nobody guarded with ready() waits here rather than leaving the page blank forever. */}
            <Loading>
              <Opened />
              {props.children}
            </Loading>
          </QueryProvider>
        </RegistryContext>
      </FramesContext>
    </Router>
  );
}

/** The page is up: the cover index.html started on (public/opening.html) goes once the page is ready (infra/opening.ts). */
function Opened() {
  const queries = useQueryClient();
  onSettled(() => {
    const stop = new AbortController();
    void reveal(queries, stop.signal);
    const unsubscribe = refetchOnRelink(frames, queries);
    return () => {
      stop.abort();
      unsubscribe();
    };
  });
  return null;
}
