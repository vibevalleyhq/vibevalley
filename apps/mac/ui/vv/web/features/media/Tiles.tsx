import { effect, Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, LibraryItem, MediaJob } from "@vibevalley/protocol";

import { useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { useAttachmentUrl } from "../../infra/attachmentFile";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { artifactIcon, artifactSuffix, kindLabel } from "../artifact";
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

/** Lightweight native deliverable cards (no WebView grid): icon, type badge, compound suffix, title, and updated time. */
export function ArtifactTiles(props: {
  artifacts: readonly Artifact[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  return (
    <View testID="library-artifacts" class="flex-row flex-wrap gap-3">
      <Each of={props.artifacts} key={(a) => a.id}>
        {(a) => {
          const picked = () => props.selectedId === a().id;
          let lastPress = 0;
          return (
            <View
              role="button"
              testID={`library-artifact-${a().id}`}
              accessibilityLabel={a().title}
              accessibilityState={{ selected: picked() }}
              onPress={() => {
                const ts = Date.now();
                if (ts - lastPress < 350 && picked()) {
                  props.onOpen(a().id);
                } else {
                  props.onSelect(a().id);
                }
                lastPress = ts;
              }}
              class={`w-56 shrink-0 gap-2 rounded-lg border-2 bg-side p-3 transition duration-120 ease-out hover:bg-hover ${
                picked() ? "border-accent bg-selected" : "border-line"
              }`}
            >
              <View class="flex-row items-center gap-2">
                <View class="size-9 shrink-0 items-center justify-center rounded-md bg-page border border-line">
                  <Icon name={artifactIcon(a())} size={20} tone="muted" />
                </View>
                <View class="min-w-0 flex-1 gap-0.5">
                  <View class="flex-row flex-wrap items-center gap-1">
                    <View class="rounded-sm bg-page px-1.5 py-0.5 border border-line">
                      <Text class="text-2xs font-medium text-ink">{kindLabel(a())}</Text>
                    </View>
                    <If when={a().isDefault}>
                      <View class="rounded-sm bg-accent px-1.5 py-0.5">
                        <Text class="text-2xs font-medium text-page">{t("web.artifact.types.defaultBadge")}</Text>
                      </View>
                    </If>
                  </View>
                  <Text class="truncate font-mono text-2xs text-faint">{artifactSuffix(a())}</Text>
                </View>
              </View>
              <Text class="truncate text-sm font-semibold text-ink">{a().title}</Text>
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 flex-1 truncate text-xs text-muted">
                  {[...(a().body === "html" ? [t("web.library.inspector.versionBadge", { version: a().version })] : []), ago(a().updated, now())].join(" · ")}
                </Text>
                <View
                  role="button"
                  testID={`library-artifact-open-${a().id}`}
                  accessibilityLabel={t("web.library.inspector.openWorkbench")}
                  onPress={() => props.onOpen(a().id)}
                  class="size-6 items-center justify-center rounded-sm hover:bg-page"
                >
                  <Icon name="open" size={12} tone="muted" />
                </View>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
