// The global VibeValley workbench (`view: "vibevalley"` in
// ui/App.tsx): the ported apps/web App on the bridge to the Rust server.
// Params: `route` (where it opens, default "/"), `locale` ("zh" default, "en").
import "../infra/polyfill";
import { cleanup, host } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { applyMotion } from "../design/motion";
import { useBridge } from "../infra/bridged";
import { readHostParams } from "../infra/hostParams";
import { appHistory } from "../infra/router";
import { SOUNDS, playSound, type SoundName } from "../infra/sound";
import { App } from "./Workbench";

const isSoundName = (name: string): name is SoundName => Object.hasOwn(SOUNDS, name);

export function VibeValley() {
  const params = readHostParams();
  setLocale(params.locale);
  applyMotion(params.motion);
  useBridge();
  const route = params.route;
  if (route !== undefined && route !== "/") appHistory.navigate(route, { replace: true });
  cleanup(host.on("route", (to) => typeof to === "string" && appHistory.navigate(to)));
  cleanup(host.on("locale", (loc) => (loc === "en" || loc === "zh") && setLocale(loc)));
  cleanup(host.on("motion", applyMotion));
  if (params.globalShell) {
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
