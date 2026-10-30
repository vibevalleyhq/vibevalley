// Development only (vp run desktop:dev sets VIBEVALLEY_DEV=1, never a packaged app): the window reloads when the page
// is built again (vp build --watch writes apps/web/dist), and the server starts again, on the same port, when its code
// or a workspace package it runs on changes; the window then comes back on the place it showed. A restart waits while a
// helper is working: it would cut the round off (the farm working on its own code is changing that code).

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";

import { VibeValleyApi } from "@vibevalley/protocol";

import type { ServerKeeper } from "./server";
import type { MainWindow } from "./window";
import { workspaceClosure } from "./workspace.ts";

/** A build writes many files; one reload once they are all there. */
const settleMs = 400;

/** How often a restart held back by working helpers asks again. */
const busyPollMs = 5_000;

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
  /** How many helpers are working now; 0 when that cannot be asked (the server is down). */
  working: () => Promise<number>;
}

/** Restarts the server once no helper is working, asking again every busyPollMs. */
export async function restartWhenIdle(h: Pick<DevHooks, "working" | "restartServer">, sleep: (ms: number) => Promise<void>): Promise<void> {
  let said = false;
  /* oxlint-disable eslint/no-await-in-loop -- a poll: each try waits for the one before */
  for (let n = await h.working(); n > 0; n = await h.working()) {
    if (!said) console.log(`vibevalley dev: the server's code changed; restarting once ${n} working helper(s) are done`);
    said = true;
    await sleep(busyPollMs);
    /* oxlint-enable eslint/no-await-in-loop */
  }
  await h.restartServer();
}

export function watchForDev(h: DevHooks): () => void {
  const watchers: FSWatcher[] = [];
  const page = debounce(h.reloadPage);
  watchers.push(watch(h.web, { recursive: true }, page));
  let restarting = Promise.resolve();
  const server = debounce(() => {
    // One restart at a time; a change during one restarts again after it.
    restarting = restarting
      .then(() => restartWhenIdle(h, (ms) => new Promise((r) => setTimeout(r, ms))))
      .catch((e: unknown) => console.error("vibevalley dev: the server did not start again:", e));
  });
  const packages = [...workspaceClosure(h.repo, join(h.repo, "apps/server")).values()].map((dir) => join(dir, "src"));
  for (const dir of [join(h.repo, "apps/server/src"), join(h.repo, "apps/server/db"), ...packages])
    watchers.push(
      watch(dir, { recursive: true }, (_event, file) => {
        // The tests' own files and the golden data do not change what runs.
        if (file && (file.endsWith(".test.ts") || file.includes("testdata"))) return;
        server();
      }),
    );
  return () => watchers.forEach((w) => w.close());
}

/** The development wiring for the app: the window reloads, and the server starts again on its port, the window coming
 * back on the place it showed. */
export function devMode(o: { readonly web: string; readonly repo: string; readonly server: ServerKeeper; readonly window: MainWindow }) {
  return watchForDev({
    web: o.web,
    repo: o.repo,
    reloadPage: () => {
      console.log("vibevalley dev: the page was built again, reloading");
      o.window.current()?.webContents.reloadIgnoringCache();
    },
    working: async () => {
      const url = o.server.url();
      if (url === undefined) return 0;
      try {
        const sessions = await new VibeValleyApi(url).session.list({});
        return sessions.filter((s) => s.phase._tag === "working").length;
      } catch {
        return 0;
      }
    },
    restartServer: async () => {
      const shown = o.window.current()?.webContents.getURL();
      const at = shown === undefined ? undefined : new URL(shown);
      console.log("vibevalley dev: the server's code changed, starting it again");
      if ((await o.server.restart()) !== undefined) o.window.open(at ? at.pathname + at.search : "");
    },
  });
}
