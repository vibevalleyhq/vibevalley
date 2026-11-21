// The global VibeValley workbench (`view: "vibevalley"` in
// ui/App.tsx): the ported apps/web App on the bridge to the Rust server.
// Params: `route` (where it opens, default "/"), `locale` ("zh" default, "en").
import "./polyfill";
import { cleanup, host } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { App } from "./web/app/App";
import { useBridge } from "./web/infra/bridged";
import { appHistory } from "./web/infra/router";
import { SOUNDS, playSound, type SoundName } from "./web/ui/pixel/sound";

const isSoundName = (name: string): name is SoundName => Object.hasOwn(SOUNDS, name);

export function VibeValley() {
  setLocale(host.params.locale === "en" ? "en" : "zh");
  useBridge();
  const route = host.params.route;
  if (typeof route === "string" && route !== "/") appHistory.navigate(route, { replace: true });
  // The shell can move the page (`route:<path>`) or change its language (`locale:<loc>`) from Rust.
  cleanup(host.on("route", (to) => typeof to === "string" && appHistory.navigate(to)));
  cleanup(host.on("locale", (loc) => (loc === "en" || loc === "zh") && setLocale(loc)));
  if (host.params.globalShell === true) {
    cleanup(
      host.on("farm-sound", (name) => {
        if (typeof name === "string" && isSoundName(name)) playSound(name);
      }),
    );
    const changed = () => host.post("action", { type: "global_route", path: appHistory.read().pathname });
    cleanup(appHistory.subscribe(changed));
    changed();
  }
  return <App />;
}
