import "./infra/polyfill";
import "./infra/i18nBoot";
import { host, mount, Text, View, type Component } from "nsh";
import { z } from "zod";

import { setLocale } from "@vibevalley/i18n";

import { DesignHostProvider, type DesignHost } from "./design/host";
import { applyMotion, setMotionReporter } from "./design/motion";
import { toast } from "./design/toasts";
import { DevToolsApp } from "./features/devtools/DevToolsApp";
import { reasonOf } from "./infra/api";
import { saveFile } from "./infra/attachmentFile";
import { act, hostApi, viewName } from "./infra/bridge";
import { useBridge } from "./infra/bridged";
import { currentHost } from "./infra/host";
import { readHostMotion } from "./infra/hostParams";
import { prefsNow, setWidth } from "./infra/state/prefs";
import { transport } from "./infra/transport";
import { BridgeProbe } from "./workspace/BridgeProbe";
import { WorkspaceChatPane } from "./workspace/ChatPane";
import { Palette } from "./workspace/Palette";
import { Sidebar } from "./workspace/Sidebar";

const QrMatrixSchema = z.object({
  size: z.number().int().positive(),
  rows: z.array(z.string()),
});

const shellDesignHost: DesignHost = {
  openExternal: (url) => hostApi.openUrl(url),
  openFile: (path) => hostApi.openFile(path),
  navigate: (path) => act({ type: "open_route", path }),
  saveFile: (path, name) => saveFile(path, name),
  renderQr: async (text, border) => {
    const res = await transport().call("host.qr", { text, border });
    if (res.bizCode !== 0) return undefined;
    const parsed = QrMatrixSchema.safeParse(res.data);
    return parsed.success ? parsed.data : undefined;
  },
  toast,
  motion: (choice) => currentHost().motion?.(choice),
  getPrefWidth: (pane) => prefsNow().widths[pane],
  setPrefWidth: (pane, width) => setWidth(pane, width),
  formatError: reasonOf,
};

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
setMotionReporter((choice) => currentHost().motion?.(choice));
applyMotion(readHostMotion());
host.on("motion", applyMotion);
if (host.available()) useBridge();

const Surface = views[viewName()] ?? Unknown;
mount(() => (
  <DesignHostProvider host={shellDesignHost}>
    <Surface />
  </DesignHostProvider>
));
if (host.available()) host.post("action", { type: "ready" });
