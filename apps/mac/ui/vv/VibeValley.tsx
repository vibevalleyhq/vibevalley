// The global VibeValley workbench (`view: "vibevalley"` in
// ui/App.tsx): the ported apps/web App on the bridge to the Rust server.
// Params: `route` (where it opens, default "/"), `locale` ("zh" default, "en").
import "./polyfill";
import { cleanup, effect, host, windowSize } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { App } from "./web/app/App";
import { useBridge } from "./web/infra/bridged";
import { appHistory } from "./web/infra/router";

export function VibeValley() {
  setLocale(host.params.locale === "en" ? "en" : "zh");
  useBridge();
  const route = host.params.route;
  if (typeof route === "string" && route !== "/") appHistory.navigate(route, { replace: true });
  // The shell can move the page: `route:<path>` from Rust.
  host.on("route", (to) => typeof to === "string" && appHistory.navigate(to));
  if (host.params.globalShell === true) {
    const changed = () => host.post("action", { type: "global_route", path: appHistory.read().pathname, rail_width: windowSize().width < 640 ? 68 : 76 });
    cleanup(appHistory.subscribe(changed));
    effect(changed);
  }
  return <App />;
}
