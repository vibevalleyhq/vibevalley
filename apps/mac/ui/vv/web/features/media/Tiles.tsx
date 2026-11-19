// Ported from VibeValley apps/web/src/features/media/Tiles.tsx: justified
// rows of media tiles and in-progress generation jobs.
import { effect, Image, Text, View } from "nsh";

import type { LibraryItem, MediaJob } from "@vibevalley/protocol";

import { useAttachmentUrl } from "../../infra/attachmentFile";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { durationText, extOf, justify, kindOf, type Placed } from "./items";

export interface Seen {
  readonly ratio?: number;
  readonly width?: number;
  readonly height?: number;
  readonly seconds?: number;
}

export const knows = ({ had, learnt }: { readonly had: Seen; readonly learnt: Seen }) =>
  (learnt.ratio === undefined || had.ratio === learnt.ratio) &&
  (learnt.width === undefined || had.width === learnt.width) &&
  (learnt.height === undefined || had.height === learnt.height) &&
  (learnt.seconds === undefined || had.seconds === learnt.seconds);

export const tileGap = 12;
const captionPx = 22;

const kindIcon: Record<"audio" | "video" | "other", IconName> = { audio: "audio", video: "video", other: "file" };

export const ratioOf = ({ item, seen }: { readonly item: LibraryItem; readonly seen: Seen | undefined }): number => {
  if (seen?.ratio !== undefined) return seen.ratio;
  switch (kindOf(item.attachment.type)) {
    case "image":
      return 1;
    case "video":
      return 16 / 9;
    case "audio":
      return 1.5;
    case "other":
      return 0.8;
  }
};

export function MakingTiles(props: { jobs: readonly MediaJob[]; width: number; height: number; label: (job: MediaJob) => string }) {
  const rows = () => justify({ ratios: props.jobs.map(() => 1), width: props.width, height: props.height, gap: tileGap });
  return (
    <View class="gap-3">
      <Each of={rows()}>
        {(row) => (
          <View class="flex-row gap-3">
            <Each of={row()}>
              {(p) => (
                <If when={props.jobs[p().index]}>
                  {(job) => (
                    <View testID="library-making" class="shrink-0 min-w-0" style={{ width: p().width, height: p().height + captionPx }}>
                      <View class="flex-1 min-h-0 items-center justify-center gap-2 rounded-md border border-dashed border-wheat bg-hover p-2">
                        <Icon name="wait" size={20} tone="wheat" />
                        <Text class="text-center text-xs text-ink">{job().phaseText}</Text>
                      </View>
                      <Text class="pt-1.5 truncate text-xs text-muted">{props.label(job())}</Text>
                    </View>
                  )}
                </If>
              )}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}

const stacked = ({
  rows,
  gap,
}: {
  readonly rows: readonly Placed[][];
  readonly gap: number;
}): { readonly at: ReadonlyMap<number, Placed & { readonly y: number }>; readonly height: number } => {
  const at = new Map<number, Placed & { readonly y: number }>();
  let y = 0;
  for (const [i, row] of rows.entries()) {
    for (const p of row) at.set(p.index, { ...p, y });
    y += (row[0]?.height ?? 0) + captionPx + (i < rows.length - 1 ? gap : 0);
  }
  return { at, height: y };
};

export function Tiles(props: {
  items: readonly LibraryItem[];
  rows: readonly Placed[][];
  picked: readonly string[];
  active: string | undefined;
  seen: (id: string) => Seen | undefined;
  onSeen: (id: string, seen: Seen) => void;
  onPick: (id: string, how: { readonly add: boolean; readonly range: boolean }) => void;
  onLook: (id: string) => void;
}) {
  const layout = () => stacked({ rows: props.rows, gap: tileGap });
  return (
    <View class="relative" style={{ height: layout().height }}>
      <Each of={props.items} key={(item) => item.attachment.id}>
        {(item, index) => (
          <If when={layout().at.get(index())}>
            {(p) => (
              <Tile
                item={item()}
                x={p().x}
                y={p().y}
                width={p().width}
                height={p().height}
                picked={props.picked.includes(item().attachment.id)}
                active={props.active === item().attachment.id}
                seen={props.seen(item().attachment.id)}
                onSeen={(s) => props.onSeen(item().attachment.id, s)}
                onPick={(how) => props.onPick(item().attachment.id, how)}
                onLook={() => props.onLook(item().attachment.id)}
              />
            )}
          </If>
        )}
      </Each>
    </View>
  );
}

function Tile(props: {
  item: LibraryItem;
  x: number;
  y: number;
  width: number;
  height: number;
  picked: boolean;
  active: boolean;
  seen: Seen | undefined;
  onSeen: (seen: Seen) => void;
  onPick: (how: { readonly add: boolean; readonly range: boolean }) => void;
  onLook: () => void;
}) {
  const file = () => props.item.attachment;
  const kind = () => kindOf(file().type);
  const url = useAttachmentUrl(() => file().id);

  effect(() => {
    const src = url();
    if (kind() === "image" && src && props.seen?.width === undefined) {
      void Image.getSize(src).then(
        (sz) => {
          if (sz.width > 0 && sz.height > 0) {
            props.onSeen({ ratio: sz.width / sz.height, width: sz.width, height: sz.height });
          }
        },
        () => {},
      );
    }
  });

  return (
    <View
      role="button"
      testID="library-item"
      accessibilityLabel={file().name}
      onPress={() => props.onPick({ add: false, range: false })}
      class="absolute shrink-0 min-w-0"
      style={{ left: props.x, top: props.y, width: props.width, height: props.height + captionPx }}
    >
      <View
        class={`flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md border-2 bg-hover ${
          props.active || props.picked ? "border-accent" : "border-transparent hover:border-line"
        }`}
      >
        <If
          when={kind() === "image" ? url() : undefined}
          else={
            <View class="items-center justify-center gap-1">
              <Icon name={kindIcon[kind() === "audio" ? "audio" : kind() === "video" ? "video" : "other"]} size={24} tone="muted" />
              <If when={extOf(file().name)}>{(ext) => <Text class="text-xs font-medium text-ink">{ext()}</Text>}</If>
              <If when={props.seen?.seconds}>{(s) => <Text class="text-xs text-faint">{durationText(s())}</Text>}</If>
            </View>
          }
        >
          {(src) => <Image src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
        </If>
      </View>
      <Text class={`pt-1.5 truncate text-xs ${props.picked ? "text-ink font-medium" : "text-muted"}`}>{file().name}</Text>
    </View>
  );
}
