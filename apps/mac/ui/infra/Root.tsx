import { cleanup, type JSX } from "nsh";

import { createFrames, frames, FramesContext } from "./frame";
import { QueryProvider, refetchOnRelink, useQueryClient } from "./query";
import { Router } from "./router";
import type { RouterHistory } from "./router/history";
import { pageRegistry, RegistryContext } from "./state/atom";

export function Root(props: { history?: RouterHistory; children: JSX.Element }) {
  return (
    <Router history={props.history}>
      <FramesContext.Provider value={createFrames()}>
        <RegistryContext.Provider value={pageRegistry}>
          <QueryProvider>
            <Opened />
            {props.children}
          </QueryProvider>
        </RegistryContext.Provider>
      </FramesContext.Provider>
    </Router>
  );
}

function Opened() {
  const queries = useQueryClient();
  cleanup(refetchOnRelink(frames, queries));
  return null;
}
