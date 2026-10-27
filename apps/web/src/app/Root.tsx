import { Loading, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { createFrames, FramesContext } from "../base/frame";
import { queries } from "../base/query";
import { createFarmUi, FarmUiContext } from "../farm/state";
import { createRouter, RouterContext } from "../base/router";

/** What every page has around it: the router, the state frames, the farm's own state, the query cache. */
export function Root(props: { children: JSX.Element }) {
  return (
    <RouterContext value={createRouter()}>
      <FramesContext value={createFrames()}>
        <FarmUiContext value={createFarmUi()}>
          <QueryClientProvider client={queries}>
            {/* A read nobody guarded with ready() waits here rather than leaving the page blank forever. */}
            <Loading>
              <Opened />
              {props.children}
            </Loading>
          </QueryClientProvider>
        </FarmUiContext>
      </FramesContext>
    </RouterContext>
  );
}

/** The page is up: the bar index.html started on (public/opening.html) goes; until then it covers the empty page. */
function Opened() {
  onSettled(() => document.getElementById("opening")?.remove());
  return null;
}
