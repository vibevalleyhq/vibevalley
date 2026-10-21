// Development only (bun run desktop:dev sets VIBEVALLEY_DEV=1, never a packaged app): the window reloads when the page
// is built again (vp build --watch writes apps/web/dist), and the server starts again, on the same port, when its code
// or the protocol's changes; the window then comes back on the place it showed.

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";

/** A build writes many files; one reload once they are all there. */
const settleMs = 400;

function debounce(f: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(f, settleMs);
  };
}

export interface DevHooks {
  /** apps/web/dist and the repository root. */
  web: string;
  repo: string;
  reloadPage: () => void;
  restartServer: () => Promise<void>;
}

export function watchForDev(h: DevHooks): () => void {
  const watchers: FSWatcher[] = [];
  const page = debounce(h.reloadPage);
  watchers.push(watch(h.web, { recursive: true }, page));
  let restarting = Promise.resolve();
  const server = debounce(() => {
    // One restart at a time; a change during one restarts again after it.
    restarting = restarting.then(h.restartServer).catch((e: unknown) => console.error("vibevalley dev: the server did not start again:", e));
  });
  for (const dir of ["apps/server/src", "apps/server/db", "packages/protocol/src"])
    watchers.push(
      watch(join(h.repo, dir), { recursive: true }, (_event, file) => {
        // The tests' own files and the golden data do not change what runs.
        if (file && (file.endsWith(".test.ts") || file.includes("testdata"))) return;
        server();
      }),
    );
  return () => watchers.forEach((w) => w.close());
}
