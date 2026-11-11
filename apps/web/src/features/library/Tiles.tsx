import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";

import { attachmentPath, type LibraryItem, type MediaJob } from "@vibevalley/protocol";

import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { styleProps } from "#/ui/positioner.ts";

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

const styles = stylex.create({
  rows: { display: "flex", flexDirection: "column", gap: tileGap },
  row: { display: "flex", gap: tileGap },
  // Absolute coordinates inside a fixed-height container keep tile DOM nodes (and decoded images) intact across row reflows.
  field: (height: number) => ({ position: "relative", height }),
  at: (x: number, y: number) => ({ position: "absolute", left: x, top: y }),
  tile: (width: number, height: number) => ({
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    width,
    height: height + captionPx,
    minWidth: 0,
    cursor: "default",
    outlineStyle: "none",
  }),
  thumb: {
    position: "relative",
    display: "flex",
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    outlineStyle: "solid",
    outlineOffset: 2,
    outlineWidth: 2,
    outlineColor: {
      default: "transparent",
      "@media (hover: hover)": { default: "transparent", ":is([data-tile]:hover > *)": "var(--color-line)" },
    },
    transitionProperty: "outline-color",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--ease-out)",
  },
  picked: { outlineColor: "var(--color-accent)" },
  active: { outlineColor: { default: "var(--color-focus)", ":is([data-picked] > *)": "var(--color-accent)" } },
  plain: {
    flexDirection: "column",
    gap: "0.25rem",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  picture: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  ext: { fontSize: "var(--text-xs)", lineHeight: "var(--leading-xs)", fontWeight: "var(--font-weight-medium)", color: "var(--color-ink)" },
  length: { fontSize: "var(--text-xs)", lineHeight: "var(--leading-xs)", color: "var(--color-faint)" },
  badge: {
    position: "absolute",
    right: "0.25rem",
    bottom: "0.25rem",
    borderRadius: "var(--radius-xs)",
    // High-contrast code tokens stay legible over bright or dark media in both themes.
    backgroundColor: "var(--color-code-bg)",
    paddingInline: "0.25rem",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-code-ink)",
  },
  caption: {
    overflow: "hidden",
    paddingTop: 6,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  captionPicked: { color: "var(--color-ink)" },
  making: {
    flexDirection: "column",
    gap: "0.5rem",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "var(--color-wheat)",
    backgroundColor: "color-mix(in srgb, var(--color-wheat) 14%, transparent)",
    padding: "0.5rem",
    textAlign: "center",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-ink)",
  },
  wait: { color: "var(--color-wheat)" },
  hidden: { display: "none" },
});

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
  const rows = () => justify({ ratios: Arr.map(props.jobs, () => 1), width: props.width, height: props.height, gap: tileGap });
  return (
    <div {...stylex.attrs(styles.rows)}>
      <For each={rows()}>
        {(row) => (
          <div {...stylex.attrs(styles.row)}>
            <For each={row}>
              {(p) => (
                <Show when={props.jobs[p.index]}>
                  {(job) => (
                    <div data-testid="library-making" data-id={job().id} data-phase={job().phase} {...styleProps(styles.tile(p.width, p.height))}>
                      <div {...stylex.attrs(styles.thumb, styles.making)}>
                        <Icon name="wait" size={20} styles={styles.wait} />
                        <span>{job().phaseText}</span>
                      </div>
                      <p {...stylex.attrs(styles.caption)}>{props.label(job())}</p>
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
    <div {...styleProps(styles.field(layout().height))}>
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
      {...styleProps([styles.tile(props.width, props.height), styles.at(props.x, props.y)])}
    >
      <Switch>
        <Match when={kind() === "image"}>
          <div {...stylex.attrs(styles.thumb, props.picked && styles.picked, props.active && styles.active)}>
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
              {...stylex.attrs(styles.picture)}
            />
          </div>
        </Match>
        <Match when={kind() === "video"}>
          <div {...stylex.attrs(styles.thumb, props.picked && styles.picked, props.active && styles.active)}>
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
              {...stylex.attrs(styles.picture)}
            />
            <Show when={props.seen?.seconds}>{(s) => <span {...stylex.attrs(styles.badge)}>{durationText(s())}</span>}</Show>
          </div>
        </Match>
        <Match when={kind() === "audio" || kind() === "other"}>
          <div {...stylex.attrs(styles.thumb, styles.plain, props.picked && styles.picked, props.active && styles.active)}>
            <Icon name={kindIcon[kind() === "audio" ? "audio" : "other"]} size={24} />
            <Show when={extOf(file().name)}>{(ext) => <span {...stylex.attrs(styles.ext)}>{ext()}</span>}</Show>
            <Show when={props.seen?.seconds}>{(s) => <span {...stylex.attrs(styles.length)}>{durationText(s())}</span>}</Show>
            <Show when={kind() === "audio" && props.seen?.seconds === undefined}>
              <audio
                src={src()}
                preload="metadata"
                aria-hidden="true"
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d)) props.onSeen({ seconds: d });
                }}
                {...stylex.attrs(styles.hidden)}
              />
            </Show>
          </div>
        </Match>
      </Switch>
      <p {...stylex.attrs(styles.caption, props.picked && styles.captionPicked)}>{file().name}</p>
    </div>
  );
}
