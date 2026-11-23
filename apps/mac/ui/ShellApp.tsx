import "./infra/polyfill";
import "./infra/i18nBoot";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { applyMotion } from "./design/motion";
import { DevToolsApp } from "./features/devtools/DevToolsApp";
import { viewName } from "./infra/bridge";
import { useBridge } from "./infra/bridged";
import { readHostMotion } from "./infra/hostParams";
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
  devtools: DevToolsApp,
  sidebar: Sidebar,
  palette: Palette,
  markdown: MarkdownPane,
  "workspace-chat": WorkspaceChatPane,
  probe: BridgeProbe,
};

host.on("locale", (loc) => {
  if (loc === "en" || loc === "zh") setLocale(loc);
});
applyMotion(readHostMotion());
host.on("motion", applyMotion);
if (host.available()) useBridge();

mount(views[viewName()] ?? Unknown);
if (host.available()) host.post("action", { type: "ready" });
