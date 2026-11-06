import { isAbsolute, normalize, relative, sep } from "node:path";

/** On macOS the window has no title bar. The preload hands this to the page (Host.titleBar). */
export const titleBar = { top: 28, left: 76 };

export const trafficLights = { x: 12, y: 8 };

/** The workbench's page in either theme (apps/web style.css). */
export const ground = (dark: boolean) => (dark ? "#151413" : "#fcfcfb");

/** The window's page runs sandboxed, apart from the preload, with no Node. */
export const pageWebPreferences = (preload: string) => ({ preload, contextIsolation: true, sandbox: true, nodeIntegration: false }) as const;

/** Where a navigation goes: the server's own origin stays in the window, a web link opens in the browser, anything else goes nowhere. */
export function navigationOf(to: string, server: string | undefined): "stay" | "browser" | "block" {
  const target = URL.canParse(to) ? new URL(to) : undefined;
  if (!target) return "block";
  if (server !== undefined && target.origin === new URL(server).origin) return "stay";
  return target.protocol === "http:" || target.protocol === "https:" ? "browser" : "block";
}

const within = (path: string, root: string) => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes(".."));
};

/** A path the page may show in Finder: absolute, and under one of roots (the person's home, the farm's home). */
export function revealable(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path) || path.includes("\0")) return false;
  const p = normalize(path);
  return roots.some((root) => within(p, normalize(root)));
}
