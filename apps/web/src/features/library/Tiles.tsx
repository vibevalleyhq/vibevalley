import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";

import { attachmentPath, type LibraryItem, type MediaJob } from "@vibevalley/protocol";

import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { durationText, extOf, justify, kindOf, type Placed } from "./items.ts";

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

const styles = {
  field: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
  at: (x: number, y: number): JSX.CSSProperties => ({ left: `${x}px`, top: `${y}px` }),
  tile: (width: number, height: number): JSX.CSSProperties => ({ width: `${width}px`, height: `${height + captionPx}px` }),
};

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

export function useWidth() {
  const [el, setEl] = createSignal<HTMLElement>();
  const [width, setWidth] = createSignal(0);
  onSettled(() => {
    const node = el();
    if (node === undefined) return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    setWidth(node.clientWidth);
    return () => watch.disconnect();
  });
  return { ref: setEl, width };
}

export function MakingTiles(props: { jobs: readonly MediaJob[]; width: number; height: number; label: (job: MediaJob) => string }) {
  const rows = () => justify({ ratios: props.jobs.map(() => 1), width: props.width, height: props.height, gap: tileGap });
  return (
    <div class="flex flex-col gap-3">
      <For each={rows()}>
        {(row) => (
          <div class="flex gap-3">
            <For each={row}>
              {(p) => (
                <Show when={props.jobs[p.index]}>
                  {(job) => (
                    <div
                      data-testid="library-making"
                      data-id={job().id}
                      data-phase={job().phase}
                      class="flex shrink-0 flex-col min-w-0 cursor-default outline-none"
                      style={styles.tile(p.width, p.height)}
                    >
                      <div
                        class={[
                          "relative flex flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md outline-solid outline-offset-2 outline-2 outline-transparent [[data-tile]:hover>&]:outline-line transition-[outline-color] duration-120 ease-out",
                          "flex-col gap-2 border border-dashed border-wheat bg-wheat/14 p-2 text-center text-xs text-ink",
                        ]}
                      >
                        <Icon name="wait" size={20} class="text-wheat" />
                        <span>{job().phaseText}</span>
                      </div>
                      <p class="pt-1.5 truncate text-xs text-muted">{props.label(job())}</p>
                    </div>
                  )}
                </Show>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
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
    <div class="relative" style={styles.field(layout().height)}>
      <For each={props.items} keyed={(item) => item.attachment.id}>
        {(item, index) => (
          <Show when={layout().at.get(index())}>
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
                onSeen={(seen) => props.onSeen(item().attachment.id, seen)}
                onPick={(how) => props.onPick(item().attachment.id, how)}
                onLook={() => props.onLook(item().attachment.id)}
              />
            )}
          </Show>
        )}
      </For>
    </div>
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
  const src = () => attachmentPath(file().id);
  return (
    <div
      role="option"
      id={`library-tile-${file().id}`}
      data-tile=""
      data-testid="library-item"
      data-key={file().id}
      data-origin={props.item.origin.kind}
      data-kind={kind()}
      data-picked={props.picked ? "" : undefined}
      aria-selected={props.picked ? "true" : "false"}
      aria-label={file().name}
      title={file().name}
      onClick={(e) => props.onPick({ add: e.metaKey || e.ctrlKey, range: e.shiftKey })}
      onDblClick={() => props.onLook()}
      class={["flex shrink-0 flex-col min-w-0 cursor-default outline-none", "absolute"]}
      style={{ ...styles.tile(props.width, props.height), ...styles.at(props.x, props.y) }}
    >
      <Switch>
        <Match when={kind() === "image"}>
          <div
            class={[
              "relative flex flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md outline-solid outline-offset-2 outline-2 transition-[outline-color] duration-120 ease-out",
              props.active
                ? "outline-focus [[data-picked]>&]:outline-accent"
                : props.picked
                  ? "outline-accent"
                  : "outline-transparent [[data-tile]:hover>&]:outline-line",
            ]}
          >
            <img
              src={src()}
              alt=""
              loading="lazy"
              draggable="false"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0)
                  props.onSeen({ ratio: img.naturalWidth / img.naturalHeight, width: img.naturalWidth, height: img.naturalHeight });
              }}
              class="w-full h-full object-cover block"
            />
          </div>
        </Match>
        <Match when={kind() === "video"}>
          <div
            class={[
              "relative flex flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md outline-solid outline-offset-2 outline-2 transition-[outline-color] duration-120 ease-out",
              props.active
                ? "outline-focus [[data-picked]>&]:outline-accent"
                : props.picked
                  ? "outline-accent"
                  : "outline-transparent [[data-tile]:hover>&]:outline-line",
            ]}
          >
            <video
              src={src()}
              preload="metadata"
              muted
              aria-hidden="true"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                props.onSeen({
                  ...(v.videoWidth > 0 && v.videoHeight > 0 ? { ratio: v.videoWidth / v.videoHeight, width: v.videoWidth, height: v.videoHeight } : {}),
                  ...(Number.isFinite(v.duration) ? { seconds: v.duration } : {}),
                });
              }}
              class="w-full h-full object-cover block"
            />
            <Show when={props.seen?.seconds}>
              {(s) => <span class="absolute right-1 bottom-1 rounded-xs bg-code-bg px-1 text-2xs text-code-ink">{durationText(s())}</span>}
            </Show>
          </div>
        </Match>
        <Match when={kind() === "audio" || kind() === "other"}>
          <div
            class={[
              "relative flex flex-1 min-h-0 items-center justify-center overflow-hidden rounded-md outline-solid outline-offset-2 outline-2 transition-[outline-color] duration-120 ease-out",
              "flex-col gap-1 bg-hover text-muted",
              props.active
                ? "outline-focus [[data-picked]>&]:outline-accent"
                : props.picked
                  ? "outline-accent"
                  : "outline-transparent [[data-tile]:hover>&]:outline-line",
            ]}
          >
            <Icon name={kindIcon[kind() === "audio" ? "audio" : "other"]} size={24} />
            <Show when={extOf(file().name)}>{(ext) => <span class="text-xs font-medium text-ink">{ext()}</span>}</Show>
            <Show when={props.seen?.seconds}>{(s) => <span class="text-xs text-faint">{durationText(s())}</span>}</Show>
            <Show when={kind() === "audio" && props.seen?.seconds === undefined}>
              <audio
                src={src()}
                preload="metadata"
                aria-hidden="true"
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d)) props.onSeen({ seconds: d });
                }}
                class="hidden"
              />
            </Show>
          </div>
        </Match>
      </Switch>
      <p class={["pt-1.5 truncate text-xs", props.picked ? "text-ink" : "text-muted"]}>{file().name}</p>
    </div>
  );
}
