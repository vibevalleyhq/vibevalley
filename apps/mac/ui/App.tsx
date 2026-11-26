// Entry of workbench and pixel-farm overlay views (`is_workbench_view` in
// apps/mac/src/hosted/mod.rs). Shell surfaces load `ShellApp.tsx` instead.
import "./infra/polyfill";
import "./infra/i18nBoot";
import { host, mount, Text, View, type Component } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { HostDesignProvider } from "./app/DesignHost";
import { VibeValley } from "./app/VibeValley";
import { installMotionReporter } from "./design/appHost";
import { applyMotion } from "./design/motion";
import { FarmForm } from "./farm/FarmForm";
import { FarmPhone } from "./farm/FarmPhone";
import { viewName } from "./infra/bridge";
import { useBridge } from "./infra/bridged";
import { readHostMotion } from "./infra/hostParams";
import { installVdpProbe } from "./infra/vdpProbe";

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
  // The shell opens it as `vv`; `vibevalley` is the name the views use.
  vv: VibeValley,
  vibevalley: VibeValley,
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
  <HostDesignProvider>
    <Surface />
  </HostDesignProvider>
));
if (host.available()) host.post("action", { type: "ready" });
