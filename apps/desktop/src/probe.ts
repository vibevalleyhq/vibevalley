// Only the Playwright test (apps/desktop/test) starts the app with VIBEVALLEY_DESKTOP_PROBE=1: a shipped app carries none.

import type { Notice, TraySummary } from "@vibevalley/protocol/host";

import type { IslandProbe } from "./island";

export interface DesktopProbe {
  /** What the page asked to show, newest last. */
  readonly notices: Notice[];
  tray: TraySummary | undefined;
  island: IslandProbe | undefined;
}

declare global {
  var vibevalleyProbe: DesktopProbe | undefined;
}

export const probe: DesktopProbe | undefined =
  process.env.VIBEVALLEY_DESKTOP_PROBE === "1" ? (globalThis.vibevalleyProbe = { notices: [], tray: undefined, island: undefined }) : undefined;
