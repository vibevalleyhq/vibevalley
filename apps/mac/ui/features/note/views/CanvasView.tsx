import { View } from "nsh";

import type { Note } from "@vibevalley/protocol";

import { useVdpNode } from "../../../infra/vdpProbe";
import { WhiteboardView } from "../WhiteboardView";

interface CanvasViewProps {
  readonly note: Note;
  readonly version?: number | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly onOpenChat?: (() => void) | undefined;
  readonly frameClass?: string | undefined;
}

/** Spatial canvas view backed by `structure/board.json` via `note.file.*` APIs. */
export function CanvasView(props: CanvasViewProps) {
  useVdpNode({ testId: "note-canvas-view", role: "region" });
  return (
    <View testID="note-canvas-view" class="min-h-0 min-w-0 flex-1">
      <WhiteboardView note={props.note} version={props.version} onOpenChat={props.onOpenChat} onRefresh={props.onRefresh} frameClass={props.frameClass} />
    </View>
  );
}
