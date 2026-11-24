import { computed, effect, Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, LibraryItem, MediaJob } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Bubble } from "../../design/Tip";
import { useAttachmentUrl } from "../../infra/attachmentFile";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
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

function CardPinButton(props: { testid: string; pinned: boolean; onToggle: () => void }) {
  const label = () => (props.pinned ? t("web.library.content.unpin") : t("web.library.content.pin"));
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={label()}
      accessibilityState={{ selected: props.pinned }}
      tooltip={<Bubble text={label()} />}
      onPress={() => props.onToggle()}
      class={`size-6 shrink-0 items-center justify-center rounded-sm border focus-visible:outline-2 focus-visible:outline-focus ${
        props.pinned
          ? "border-line bg-warn-soft opacity-100"
          : "border-transparent bg-transparent opacity-0 group-hover:opacity-100 hover:bg-selected focus:opacity-100"
      }`}
    >
      <Icon name="pin" size={12} tone={props.pinned ? "warn-ink" : "muted"} />
    </View>
  );
}

export function MakingTiles(props: { jobs: readonly MediaJob[]; width: number; height: number; label: (job: MediaJob) => string }) {
  const rows = computed(() => justify({ ratios: props.jobs.map(() => 1), width: props.width, height: props.height, gap: tileGap }));
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
                      <View class="flex-1 min-h-0 items-center justify-center gap-2 rounded-md border border-dashed border-wheat bg-side p-2">
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
  isPinned?: ((id: string) => boolean) | undefined;
  seen: (id: string) => Seen | undefined;
  onSeen: (id: string, seen: Seen) => void;
  onPick: (id: string, how: { readonly add: boolean; readonly range: boolean }) => void;
  onLook: (id: string) => void;
}) {
  const layout = computed(() => stacked({ rows: props.rows, gap: tileGap }));
  const pickedSet = computed(() => new Set(props.picked));
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
                picked={pickedSet().has(item().attachment.id)}
                active={props.active === item().attachment.id}
                pinned={props.isPinned?.(item().attachment.id) === true}
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
  pinned: boolean;
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
      tooltip={<Bubble text={file().name} />}
      onPress={(e) => {
        if (kind() === "image" && e.clickCount >= 2) {
          props.onLook();
          return;
        }
        props.onPick({ add: e.modifiers.platform || e.modifiers.control, range: e.modifiers.shift });
      }}
      class="absolute shrink-0 min-w-0"
      style={{ left: props.x, top: props.y, width: props.width, height: props.height + captionPx }}
    >
      <View
        class={`relative flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md border bg-side ${
          props.active || props.picked ? "border-accent" : "border-line hover:border-faint"
        }`}
      >
        <If
          when={kind() === "image" ? url() : undefined}
          else={
            <View class="items-center justify-center gap-1">
              <Icon name={kindIcon[kind() === "audio" ? "audio" : kind() === "video" ? "video" : "other"]} size={24} tone="muted" />
              <If when={extOf(file().name)}>{(ext) => <Text class="font-mono text-2xs font-medium text-ink">{ext()}</Text>}</If>
              <If when={props.seen?.seconds}>{(s) => <Text class="font-mono text-2xs text-faint tabular-nums">{durationText(s())}</Text>}</If>
            </View>
          }
        >
          {(src) => <Image src={src()} style={{ width: props.width, height: props.height, objectFit: "cover" }} />}
        </If>
        <If when={props.pinned}>
          <View class="pointer-events-none absolute top-1.5 right-1.5 size-5 items-center justify-center rounded-sm border border-line bg-warn-soft">
            <Icon name="pin" size={10} tone="warn-ink" />
          </View>
        </If>
        <If when={props.active || props.picked}>
          <View class="pointer-events-none absolute inset-0 rounded-sm border border-accent" />
        </If>
      </View>
      <Text class={`pt-1.5 truncate text-xs font-medium ${props.picked ? "text-ink" : "text-muted"}`}>{file().name}</Text>
    </View>
  );
}

export function ArtifactTiles(props: {
  artifacts: readonly Artifact[];
  onOpen: (id: string) => void;
  isPinned: (id: string) => boolean;
  onTogglePin: (id: string) => void;
}) {
  const now = useNow();
  return (
    <View testID="library-artifacts" class="flex-row flex-wrap gap-3">
      <Each of={props.artifacts} key={(a) => a.id}>
        {(a) => {
          const pinned = () => props.isPinned(a().id);
          return (
            <View
              role="button"
              testID={`library-artifact-${a().id}`}
              accessibilityLabel={a().title}
              tooltip={<Bubble text={a().title} />}
              onPress={() => props.onOpen(a().id)}
              class="group relative w-56 shrink-0 gap-2.5 rounded-lg border border-line bg-page p-3 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
            >
              <View class="flex-row items-start gap-2.5">
                <View class="size-8 shrink-0 items-center justify-center rounded-md bg-side">
                  <Icon name={artifactIcon(a())} size={16} tone="muted" />
                </View>
                <View class="min-w-0 flex-1 gap-0.5">
                  <View class="flex-row flex-wrap items-center gap-1">
                    <View class="h-5 items-center justify-center rounded-sm bg-side px-1.5">
                      <Text class="text-2xs font-medium text-ink">{kindLabel(a())}</Text>
                    </View>
                    <If when={a().isDefault}>
                      <View class="h-5 items-center justify-center rounded-sm bg-accent px-1.5">
                        <Text class="text-2xs font-semibold text-page">{t("web.artifact.types.defaultBadge")}</Text>
                      </View>
                    </If>
                  </View>
                  <Text class="truncate font-mono text-2xs text-faint">{artifactSuffix(a())}</Text>
                </View>
                <CardPinButton testid={`library-artifact-pin-${a().id}`} pinned={pinned()} onToggle={() => props.onTogglePin(a().id)} />
              </View>
              <Text class="truncate text-sm font-semibold text-ink">{a().title}</Text>
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 flex-1 truncate text-xs text-muted">
                  {[...(a().body === "html" ? [t("web.library.inspector.versionBadge", { version: a().version })] : []), ago(a().updated, now())].join(" · ")}
                </Text>
                <Icon name="open" size={12} tone="faint" />
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
