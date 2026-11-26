// Which host the page runs in. Inside the app the
// page is a hosted view, and the host's calls go
// through the bridge (ui/bridge.ts hostApi). Without a host (headless
// tests and stories) it is the plain browser host.
import { host } from "nsh";

import { CommandLineState, type Host, UpdateState } from "@vibevalley/protocol/host";

import { hostApi, type Envelope } from "./bridge";
import { hasHostView } from "./hostParams";

const UPDATE_FALLBACK_POLL_MS = 60_000;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

/** Clamps an update download percentage to a whole number between 0 and 100. */
export function clampUpdatePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Formats downloaded/total bytes and transfer speed for the update progress UI. */
export function formatUpdateTransfer(info: {
  readonly downloadedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
  readonly speedBps?: number | undefined;
}): string | undefined {
  const parts: string[] = [];
  const { downloadedBytes, totalBytes, speedBps } = info;
  if (downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0) {
    if (totalBytes >= BYTES_PER_MB) {
      parts.push(`${(downloadedBytes / BYTES_PER_MB).toFixed(1)} / ${(totalBytes / BYTES_PER_MB).toFixed(1)} MB`);
    } else {
      parts.push(`${Math.round(downloadedBytes / BYTES_PER_KB)} / ${Math.round(totalBytes / BYTES_PER_KB)} KB`);
    }
  } else if (downloadedBytes !== undefined && downloadedBytes > 0) {
    parts.push(
      downloadedBytes >= BYTES_PER_MB ? `${(downloadedBytes / BYTES_PER_MB).toFixed(1)} MB` : `${Math.max(1, Math.round(downloadedBytes / BYTES_PER_KB))} KB`,
    );
  }
  if (speedBps !== undefined && speedBps > 0) {
    parts.push(speedBps >= BYTES_PER_MB ? `${(speedBps / BYTES_PER_MB).toFixed(1)} MB/s` : `${Math.max(1, Math.round(speedBps / BYTES_PER_KB))} KB/s`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

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
    captureWebView: async (options) => {
      const e = await hostApi.captureWebView(options);
      return e.bizCode === 0 ? (e.data ?? null) : null;
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
        let pushOff: (() => void) | undefined;
        let pushSeq = 0;
        const scheduleRefresh = () => {
          if (timer !== undefined) clearTimeout(timer);
          if (!stopped) timer = setTimeout(() => void poll(), UPDATE_FALLBACK_POLL_MS);
        };
        const poll = async () => {
          if (stopped) return;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (inFlight) return inFlight;
          const seenPush = pushSeq;
          inFlight = (async () => {
            try {
              const response = await hostApi.updateState();
              if (stopped || pushSeq !== seenPush) return;
              const decoded = UpdateState.safeParse(response.data);
              if (response.bizCode === 0 && decoded.success) {
                listener(decoded.data);
              } else {
                listener({
                  _tag: "failed",
                  version: "",
                  why: response.bizCode !== 0 ? response.message : (decoded.error?.message ?? "Invalid update state"),
                  kind: "unknown",
                });
              }
            } finally {
              inFlight = undefined;
              scheduleRefresh();
            }
          })();
          return inFlight;
        };
        // Detach from any reactive owner (same pattern as bridge.ts) so transient effects never drop push events.
        if (host.available()) {
          queueMicrotask(() => {
            if (stopped) return;
            pushOff = host.on("update_state", (payload) => {
              if (stopped) return;
              const decoded = UpdateState.safeParse(payload);
              if (!decoded.success) return;
              pushSeq += 1;
              listener(decoded.data);
              scheduleRefresh();
            });
          });
        }
        updateRefreshers.add(poll);
        void poll();
        return () => {
          stopped = true;
          updateRefreshers.delete(poll);
          pushOff?.();
          pushOff = undefined;
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
