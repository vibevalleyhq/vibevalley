/** In development (scripts/dev.ts) the page comes from Vite's dev server, which sends /api to the server on a port it chose first. */
export interface DevPage {
  /** Vite's origin, without a trailing slash: the window loads it and stays on it. */
  readonly page: string;
  readonly serverPort: number;
}

export const devPageEnv = (d: DevPage): Record<string, string> => ({
  VIBEVALLEY_DEV_PAGE: d.page.replace(/\/+$/u, ""),
  VIBEVALLEY_DEV_SERVER_PORT: String(d.serverPort),
});

/** The dev page dev.ts said, or undefined when it said none (or said it wrong): then the window opens on the server as a packaged app does. */
export function devPageOf(env: Readonly<Record<string, string | undefined>>): DevPage | undefined {
  const page = env.VIBEVALLEY_DEV_PAGE;
  const port = Number(env.VIBEVALLEY_DEV_SERVER_PORT);
  if (page === undefined || !URL.canParse(page) || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  const url = new URL(page);
  // Only Vite on this machine: the window gives the page's origin the host's bridge and its permissions.
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) return undefined;
  return { page: url.origin, serverPort: port };
}
