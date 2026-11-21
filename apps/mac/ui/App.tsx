// Entry of every hosted view. Rust sets `host.params.view` before the
// bundle loads; one bundle serves all surfaces.
import "./infra/polyfill";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { VibeValley } from "./app/VibeValley";
import { FarmForm } from "./farm/FarmForm";
import { FarmPhone } from "./farm/FarmPhone";
import { viewName } from "./infra/bridge";
import { BridgeProbe } from "./workspace/BridgeProbe";
import { MarkdownPane } from "./workspace/MarkdownPane";
import { Palette } from "./workspace/Palette";
import { Sidebar } from "./workspace/Sidebar";

function Unknown() {
  return (
    <View class="flex-1 items-center justify-center bg-side">
      <Text class="text-sm text-muted">No hosted view named “{viewName()}”.</Text>
    </View>
  );
}

const views: Record<string, Component> = {
  "farm-form": FarmForm,
  "farm-phone": FarmPhone,
  sidebar: Sidebar,
  palette: Palette,
  markdown: MarkdownPane,
  probe: BridgeProbe,
  // The shell opens it as `vv`; `vibevalley` is the name the views use.
  vv: VibeValley,
  vibevalley: VibeValley,
};

setLocale(host.params.locale === "en" ? "en" : "zh");
host.on("locale", (loc) => {
  if (loc === "en" || loc === "zh") setLocale(loc);
});

mount(views[viewName()] ?? Unknown);
if (host.available()) host.post("action", { type: "ready" });
