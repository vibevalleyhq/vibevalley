// How the workbench looks on this machine (设置 › 外观, state/prefs.ts): the theme as <html data-theme> (light or dark,
// "system" worked out from the system's own and followed when it changes), told to the host so its own parts follow;
// and the interface size as --workbench-zoom, which only the workbench's shell reads (the farm keeps its whole-number
// scaling).

import { currentHost } from "@/infra/host";

import { prefsNow, subscribePrefs } from "./prefs";

const dark = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply() {
  const { theme, scale } = prefsNow();
  const root = document.documentElement;
  root.dataset.theme = theme === "system" ? (dark().matches ? "dark" : "light") : theme;
  root.style.setProperty("--workbench-zoom", String(scale / 100));
  currentHost().theme?.(theme);
}

/** Once, as the page starts: applied now and whenever the choice or the system's theme changes. */
export function followAppearance() {
  apply();
  subscribePrefs(apply);
  dark().addEventListener("change", apply);
}
