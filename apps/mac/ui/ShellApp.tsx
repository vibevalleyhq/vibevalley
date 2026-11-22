import "./infra/polyfill";
import "./infra/i18nBoot";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { applyMotion } from "./design/motion";
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
  sidebar: Sidebar,
  palette: Palette,
  markdown: MarkdownPane,
  "workspace-chat": WorkspaceChatPane,
  probe: BridgeProbe,
};

host.on("locale", (loc) => {
  if (loc === "en" || loc === "zh") setLocale(loc);
});
applyMotion(host.params.motion);
host.on("motion", applyMotion);

mount(views[viewName()] ?? Unknown);
if (host.available()) host.post("action", { type: "ready" });
