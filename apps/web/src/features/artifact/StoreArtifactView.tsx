import { Match, Switch } from "solid-js";

import type { Artifact } from "@vibevalley/protocol";

import { DashboardView } from "./DashboardView";
import { DesignCanvasView } from "./DesignCanvasView";
import { DesignSystemView } from "./DesignSystemView";
import { MotionStoreView } from "./MotionStoreView";
import { SlidesStoreView } from "./SlidesStoreView";
import { WhiteboardView } from "./WhiteboardView";

export function StoreArtifactView(props: { artifact: Artifact }) {
  return (
    <Switch fallback={<DesignCanvasView artifact={props.artifact} />}>
      <Match when={props.artifact.artifactType === "slides"}>
        <SlidesStoreView artifact={props.artifact} />
      </Match>
      <Match when={props.artifact.artifactType === "dashboard"}>
        <DashboardView artifact={props.artifact} />
      </Match>
      <Match when={props.artifact.artifactType === "motion"}>
        <MotionStoreView artifact={props.artifact} />
      </Match>
      <Match when={props.artifact.artifactType === "whiteboard"}>
        <WhiteboardView artifact={props.artifact} />
      </Match>
      <Match when={props.artifact.artifactType === "design"}>
        <DesignCanvasView artifact={props.artifact} />
      </Match>
      <Match when={props.artifact.artifactType === "design-system"}>
        <DesignSystemView artifact={props.artifact} />
      </Match>
    </Switch>
  );
}
