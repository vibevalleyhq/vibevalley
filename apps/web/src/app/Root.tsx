import type { JSX } from "@solidjs/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { Loading, onSettled } from "solid-js";

import { createFrames, frames, FramesContext } from "#/infra/frame.ts";
import { reveal } from "#/infra/opening.ts";
import { queries, refetchOnRelink } from "#/infra/query.ts";
import { createRouter, RouterContext } from "#/infra/router.ts";
import { pageRegistry, RegistryContext } from "#/state/atom.ts";

/** What every page has around it: the router, the state frames, the atoms' registry (intents, the page's own values),
 * the query cache. */
export function Root(props: { children: JSX.Element }) {
  return (
    <RouterContext value={createRouter()}>
      <FramesContext value={createFrames()}>
        <RegistryContext value={pageRegistry}>
          <QueryClientProvider client={queries}>
            {/* A read nobody guarded with ready() waits here rather than leaving the page blank forever. */}
            <Loading>
              <Opened />
              {props.children}
            </Loading>
          </QueryClientProvider>
        </RegistryContext>
      </FramesContext>
    </RouterContext>
  );
}

/** The page is up: the cover index.html started on (public/opening.html) goes once the page is ready (infra/opening.ts).
 * From then on the REST reads are read again whenever the state stream comes back. */
function Opened() {
  onSettled(() => {
    void reveal();
    return refetchOnRelink(frames);
  });
  return null;
}
