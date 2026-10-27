import { For, Match, Switch } from "solid-js";
import { CardColors, type Piece } from "./card";
import type { SpriteAtlas } from "./atlas";

/** A helper's head, cut from its attention drawing (`<look>-down`, else the bear farmer's), on a leaf green ground. */
export function AnimalFace(props: { atlas: SpriteAtlas; look: string; size: number }) {
  const cut = () => {
    const sp = props.atlas.has(`${props.look}-down`) ? props.atlas.get(`${props.look}-down`) : props.atlas.get("bear-farmer-down");
    const k = props.size / (sp.h * 0.5);
    return { url: sp.url, left: props.size / 2 - (sp.w / 2) * k, top: props.size / 2 - (sp.h * 0.25 + sp.h * 0.03) * k, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span
      class="relative inline-block shrink-0 overflow-hidden bg-leaf-300/60"
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      aria-hidden="true"
    >
      <img
        src={cut().url}
        alt=""
        draggable="false"
        class="absolute max-w-none [image-rendering:pixelated]"
        style={{ left: `${cut().left}px`, top: `${cut().top}px`, width: `${cut().width}px`, height: `${cut().height}px` }}
      />
    </span>
  );
}

function PieceView(props: { piece: Piece; ink: string; maxWidth?: number; maxLines?: number; center: boolean }) {
  return (
    <Switch>
      <Match when={props.piece.kind === "words" ? props.piece : undefined}>
        {(p) => (
          <span
            class={["font-pixel font-normal", { "overflow-hidden": props.maxLines !== undefined, "text-center": props.center }]}
            style={{
              "font-size": `${p().size ?? 12}px`,
              "line-height": `${(p().size ?? 12) + 2}px`,
              color: p().color ?? props.ink,
              "max-width": props.maxWidth !== undefined ? `${props.maxWidth}px` : undefined,
              ...(props.maxLines !== undefined ? { display: "-webkit-box", "-webkit-box-orient": "vertical", "-webkit-line-clamp": props.maxLines } : {}),
            }}
          >
            {p().text}
          </span>
        )}
      </Match>
      <Match when={props.piece.kind === "icon" ? props.piece : undefined}>
        {(p) => (
          <img
            src={p().sprite.url}
            alt=""
            draggable="false"
            class="shrink-0 [image-rendering:pixelated]"
            style={{ height: `${p().px}px`, width: `${(p().px * p().sprite.w) / p().sprite.h}px` }}
          />
        )}
      </Match>
      <Match when={props.piece.kind === "glyph" ? props.piece : undefined}>
        {(p) => {
          const grid = () => p().grid ?? { w: 10, h: 16 };
          return (
            <svg
              width={(p().px * grid().w) / grid().h}
              height={p().px}
              viewBox={`0 0 ${grid().w} ${grid().h}`}
              shape-rendering="crispEdges"
              class="shrink-0"
              aria-hidden="true"
            >
              <For each={p().cells}>{([x, y, w, h, c]) => <rect x={x} y={y} width={w} height={h} fill={c} />}</For>
            </svg>
          );
        }}
      </Match>
      <Match when={props.piece.kind === "faces" ? props.piece : undefined}>
        {(p) => {
          const px = () => p().px ?? 22;
          const n = () => p().looks.length;
          return (
            <span class="relative shrink-0" style={{ width: `${n() === 0 ? 0 : px() + (n() - 1) * (px() - 10)}px`, height: `${px()}px` }}>
              {/* The first is drawn last, on top. */}
              <For each={p().looks} keyed={false}>
                {(look, i) => (
                  <span class="absolute top-0" style={{ left: `${i * (px() - 10)}px`, "z-index": n() - i }}>
                    <AnimalFace atlas={p().atlas} look={look()} size={px()} />
                  </span>
                )}
              </For>
            </span>
          );
        }}
      </Match>
      <Match when={props.piece.kind === "bar" ? props.piece : undefined}>
        {(p) => {
          // Whole twentieths, so the fill moves in steps.
          const steps = () => Math.round(Math.min(1, Math.max(0, p().fill)) * 20) / 20;
          return (
            <span class="relative shrink-0" style={{ width: `${p().w}px`, height: `${p().h}px`, background: p().track ?? CardColors.barTrack }}>
              <span class="absolute inset-y-0 left-0" style={{ width: `${Math.round(p().w * steps())}px`, background: p().color ?? CardColors.barFill }} />
            </span>
          );
        }}
      </Match>
    </Switch>
  );
}

/** A HUD sign: rows of pieces 3 px apart on paper with an ink border and a hard drop. `width` and `height` include the border. */
export function PixelCard(props: {
  rows: readonly (readonly Piece[])[];
  paper?: string;
  ink?: string;
  padX?: number;
  padY?: number;
  width?: number;
  height?: number;
  center?: boolean;
  maxWidth?: number;
  maxLines?: number;
}) {
  const centred = () => !!props.center || props.width !== undefined || props.height !== undefined;
  return (
    <div class="inline-block pr-0.5 pb-0.5">
      <div
        class={["box-border flex border-2 shadow-[2px_2px_0_0_#3a2a1899]", { "items-center justify-center": centred() }]}
        style={{
          background: props.paper ?? CardColors.paper,
          "border-color": CardColors.ink,
          padding: `${props.padY ?? 3}px ${props.padX ?? 6}px`,
          "min-width": props.width !== undefined ? `${props.width}px` : undefined,
          "min-height": props.height !== undefined ? `${props.height}px` : undefined,
        }}
      >
        <div class={["flex flex-col", props.center ? "items-center" : "items-start"]}>
          <For each={props.rows} keyed={false}>
            {(row) => (
              <div class="flex items-center gap-[3px]">
                <For each={row()} keyed={false}>
                  {(p) => (
                    <PieceView piece={p()} ink={props.ink ?? CardColors.ink} maxWidth={props.maxWidth} maxLines={props.maxLines} center={!!props.center} />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
