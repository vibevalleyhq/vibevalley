// Which host the page runs in. Inside the app the
// page is a hosted view, and the host's calls go
// through the bridge (ui/bridge.ts hostApi). Without a host (headless
// tests and stories) it is the plain browser host.
import { CommandLineState, type Host, UpdateState } from "@vibevalley/protocol/host";

import { hostApi, type Envelope } from "./bridge";
import { hasHostView } from "./hostParams";

const done = async (pending: Promise<Envelope>) => {
  const e = await pending;
  if (e.bizCode !== 0) throw new Error(e.message);
};

const commandLineState = async (pending: Promise<Envelope>) => {
  const e = await pending;
  if (e.bizCode !== 0) throw new Error(e.message);
  return CommandLineState.parse(e.data);
};

const unwrap = async <T>(pending: Promise<Envelope<T>>): Promise<T> => {
  const e = await pending;
  if (e.bizCode !== 0 || e.data === undefined) throw new Error(e.message);
  return e.data;
};

const desktop: Host = (() => {
  const updateRefreshers = new Set<() => Promise<void>>();
  return {
    name: "desktop",
    commandLine: {
      state: () => commandLineState(hostApi.cliState()),
      install: () => commandLineState(hostApi.cliInstall()),
      remove: () => commandLineState(hostApi.cliRemove()),
    },
    applet: {
      list: () => unwrap(hostApi.appletList()),
      install: (input) => unwrap(hostApi.appletInstall(input)),
      uninstall: (artifactId) => unwrap(hostApi.appletUninstall(artifactId)),
      open: (artifactId) => unwrap(hostApi.appletOpen(artifactId)),
    },
    notify: (notice) => done(hostApi.notify(notice)),
    tray: (summary) => done(hostApi.tray(summary)),
    locale: (locale) => void hostApi.locale(locale),
    reveal: (path) => void hostApi.reveal(path),
    theme: (theme) => void hostApi.theme(theme),
    motion: (choice) => void hostApi.motion(choice),
    opening: (opening) => done(hostApi.opening(opening)),
    update: {
      watch: (listener) => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let inFlight: Promise<void> | undefined;
        let nextDelayMs = 10_000;
        const poll = async () => {
          if (stopped) return;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (inFlight) return inFlight;
          inFlight = (async () => {
            try {
              const response = await hostApi.updateState();
              if (stopped) return;
              const decoded = UpdateState.safeParse(response.data);
              if (response.bizCode === 0 && decoded.success) {
                nextDelayMs = decoded.data._tag === "checking" || decoded.data._tag === "downloading" ? 1_000 : 10_000;
                listener(decoded.data);
              } else {
                nextDelayMs = 10_000;
                listener({ _tag: "failed", version: "", why: response.bizCode !== 0 ? response.message : (decoded.error?.message ?? "Invalid update state") });
              }
            } finally {
              inFlight = undefined;
              if (!stopped) timer = setTimeout(() => void poll(), nextDelayMs);
            }
          })();
          return inFlight;
        };
        updateRefreshers.add(poll);
        void poll();
        return () => {
          stopped = true;
          updateRefreshers.delete(poll);
          if (timer !== undefined) clearTimeout(timer);
        };
      },
      check: async () => {
        try {
          await done(hostApi.updateCheck());
        } finally {
          await Promise.all([...updateRefreshers].map((refresh) => refresh()));
        }
      },
      install: () => done(hostApi.updateInstall()),
    },
  };
})();

const browser: Host = { name: "browser" };

export function currentHost(): Host {
  return hasHostView() ? desktop : browser;
}
