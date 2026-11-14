// Which host the page runs in. Inside the app the
// page is a hosted view, and the host's calls go
// through the bridge (ui/bridge.ts hostApi). Without a host (headless
// tests and stories) it is the plain browser host.
import { host } from "nsh";

import { type Host, UpdateState } from "@vibevalley/protocol/host";

import { hostApi, type Envelope } from "../../../bridge";

const done = async (pending: Promise<Envelope>) => {
  const e = await pending;
  if (e.bizCode !== 0) throw new Error(e.message);
};

const desktop: Host = {
  name: "desktop",
  notify: (notice) => done(hostApi.notify(notice)),
  tray: (summary) => done(hostApi.tray(summary)),
  locale: (locale) => void hostApi.locale(locale),
  reveal: (path) => void hostApi.reveal(path),
  theme: (theme) => void hostApi.theme(theme),
  opening: (opening) => done(hostApi.opening(opening)),
  update: {
    watch: (listener) => {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        const response = await hostApi.updateState();
        if (stopped) return;
        const decoded = UpdateState.safeParse(response.data);
        if (response.bizCode === 0 && decoded.success) listener(decoded.data);
        else listener({ _tag: "failed", version: "", why: response.bizCode !== 0 ? response.message : (decoded.error?.message ?? "Invalid update state") });
        timer = setTimeout(() => void poll(), 1_000);
      };
      void poll();
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
    check: () => done(hostApi.updateCheck()),
    install: () => done(hostApi.updateInstall()),
  },
};

const browser: Host = { name: "browser" };

export function currentHost(): Host {
  return host.available() && host.params.view !== undefined ? desktop : browser;
}
