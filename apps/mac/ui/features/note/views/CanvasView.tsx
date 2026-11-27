import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Note } from "@vibevalley/protocol";

import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { useVdpNode } from "../../../infra/vdpProbe";
import { WhiteboardView } from "../WhiteboardView";

export interface CanvasViewProps {
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
    <View testID="note-canvas-view" class="min-h-0 min-w-0 flex-1 gap-2 p-3">
      <View class="h-8 shrink-0 flex-row items-center justify-between gap-2 px-1">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Icon name="appearance" size={14} tone="muted" />
          <Text class="min-w-0 truncate text-sm font-semibold text-ink">{props.note.title}</Text>
          <Text class="shrink-0 rounded-xs border border-line bg-side px-1.5 py-px font-mono text-2xs text-muted tabular-nums">{`seq ${props.note.seq}`}</Text>
        </View>
        <If when={props.onRefresh}>
          <IconButton icon="refresh" size={14} label={t("web.issue.page.refresh")} testid="canvas-refresh" onClick={() => props.onRefresh?.()} />
        </If>
      </View>
      <WhiteboardView note={props.note} version={props.version} onOpenChat={props.onOpenChat} onRefresh={props.onRefresh} frameClass={props.frameClass} />
    </View>
  );
}
