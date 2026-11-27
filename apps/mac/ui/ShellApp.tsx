import "./infra/polyfill";
import "./infra/i18nBoot";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { createAppDesignHost, installMotionReporter } from "./app/DesignHost";
import { DesignHostProvider } from "./design/host";
import { applyMotion } from "./design/motion";
import { DevToolsApp } from "./features/devtools/DevToolsApp";
import { act, viewName } from "./infra/bridge";
import { useBridge } from "./infra/bridged";
import { readHostMotion } from "./infra/hostParams";
import { installVdpProbe } from "./infra/vdpProbe";
import { BridgeProbe } from "./workspace/BridgeProbe";
import { WorkspaceChatPane } from "./workspace/ChatPane";
import { Palette } from "./workspace/Palette";
import { Sidebar } from "./workspace/Sidebar";

const shellDesignHost = createAppDesignHost((path) => act({ type: "open_route", path }));

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
  "workspace-chat": WorkspaceChatPane,
  probe: BridgeProbe,
};

host.on("locale", (loc) => {
  if (loc === "en" || loc === "zh") setLocale(loc);
});
installMotionReporter();
applyMotion(readHostMotion());
host.on("motion", applyMotion);
if (host.available()) {
  useBridge();
  installVdpProbe();
}

const Surface = views[viewName()] ?? Unknown;
mount(() => (
  <DesignHostProvider host={shellDesignHost}>
    <Surface />
  </DesignHostProvider>
));
if (host.available()) host.post("action", { type: "ready" });
