import "./infra/polyfill";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { applyMotion } from "./design/motion";
import { FarmForm } from "./farm/FarmForm";
import { FarmPhone } from "./farm/FarmPhone";
import { viewName } from "./infra/bridge";
import { BridgeProbe } from "./workspace/BridgeProbe";
import { WorkspaceChatPane } from "./workspace/ChatPane";
import { MarkdownPane } from "./workspace/MarkdownPane";
import { Palette } from "./workspace/Palette";
import { Sidebar } from "./workspace/Sidebar";

function Unknown() {
  return (
    <View class="flex-1 items-center justify-center bg-side">
      <Text class="text-sm text-muted">No hosted shell view named “{viewName()}”.</Text>
    </View>
  );
}

const views: Record<string, Component> = {
  "farm-form": FarmForm,
  "farm-phone": FarmPhone,
  sidebar: Sidebar,
  palette: Palette,
  markdown: MarkdownPane,
  "workspace-chat": WorkspaceChatPane,
  probe: BridgeProbe,
};

setLocale(host.params.locale === "en" ? "en" : "zh");
host.on("locale", (loc) => {
  if (loc === "en" || loc === "zh") setLocale(loc);
});
applyMotion(host.params.motion);
host.on("motion", applyMotion);

mount(views[viewName()] ?? Unknown);
if (host.available()) host.post("action", { type: "ready" });
