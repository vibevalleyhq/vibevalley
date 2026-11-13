// Which host the page runs in. Inside the app the
// page is a hosted view, and the host's calls go
// through the bridge (ui/bridge.ts hostApi). Without a host (headless
// tests and stories) it is the plain browser host.
import { host } from "nsh";

import { type Host } from "@vibevalley/protocol/host";

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
};

const browser: Host = { name: "browser" };

export function currentHost(): Host {
  return host.available() && host.params.view !== undefined ? desktop : browser;
}
