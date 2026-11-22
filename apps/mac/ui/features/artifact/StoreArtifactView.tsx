import type { Artifact } from "@vibevalley/protocol";

import { BlocksView } from "./BlocksView";
import { DashboardView } from "./DashboardView";
import { DesignCanvasView } from "./DesignCanvasView";
import { DesignSystemView } from "./DesignSystemView";
import { MotionStoreView } from "./MotionStoreView";
import { SlidesStoreView } from "./SlidesStoreView";
import { WhiteboardView } from "./WhiteboardView";

/** Shared props accepted by all structured store artifact viewers. */
export interface StoreViewerProps {
  readonly artifact: Artifact;
  readonly covered?: boolean;
  readonly onPresent?: (on: boolean) => void;
  readonly onOpenChat?: () => void;
  readonly frameClass?: string;
}

export function StoreArtifactView(props: StoreViewerProps) {
  const kind = () => props.artifact.artifactType;
  return (
    <>
      <If when={kind() === "docs" || kind() === "outline"}>
        <BlocksView id={props.artifact.id} artifactType={kind()} />
      </If>
      <If when={kind() === "slides"}>
        <SlidesStoreView {...props} />
      </If>
      <If when={kind() === "dashboard"}>
        <DashboardView {...props} />
      </If>
      <If when={kind() === "motion"}>
        <MotionStoreView {...props} />
      </If>
      <If when={kind() === "whiteboard"}>
        <WhiteboardView {...props} />
      </If>
      <If when={kind() === "design-system"}>
        <DesignSystemView {...props} />
      </If>
      <If when={kind() === "design" || kind() === undefined}>
        <DesignCanvasView {...props} />
      </If>
    </>
  );
}
