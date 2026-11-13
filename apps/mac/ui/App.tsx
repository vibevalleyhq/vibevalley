// Entry of every hosted view. Rust sets `host.params.view` before the
// bundle loads; one bundle serves all surfaces.
import { host, mount, Text, View, type Component } from "nsh";

import { viewName } from "./bridge";
import { AgentPane } from "./surfaces/AgentPane";
import { BridgeProbe } from "./surfaces/BridgeProbe";
import { MarkdownPane } from "./surfaces/MarkdownPane";
import { Palette } from "./surfaces/Palette";
import { Sidebar } from "./surfaces/Sidebar";
import { tok } from "./tokens";
import { VibeValley } from "./vv/VibeValley";

function Unknown() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: tok().canvas }}>
      <Text style={{ fontSize: 13, color: tok().muted }}>No hosted view named “{viewName()}”.</Text>
    </View>
  );
}

const views: Record<string, Component> = {
  sidebar: Sidebar,
  palette: Palette,
  agent: AgentPane,
  markdown: MarkdownPane,
  probe: BridgeProbe,
  // The shell opens it as `vv`; `vibevalley` is the name the views use.
  vv: VibeValley,
  vibevalley: VibeValley,
};

mount(views[viewName()] ?? Unknown);
if (host.available()) host.post("action", { type: "ready" });
