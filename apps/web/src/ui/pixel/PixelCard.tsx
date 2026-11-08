import * as stylex from "@stylexjs/stylex";
import { For, Match, Switch } from "solid-js";

import type { BadgeTone } from "@vibevalley/protocol";

import type { SpriteAtlas, SpriteInfo } from "./atlas";

const recipeStyles2 = stylex.create({
  animalFaceSpan: {
    position: "relative",
    display: "inline-block",
    flexShrink: "0",
    overflow: "hidden",
    backgroundColor: {
      default: "var(--color-leaf-300)99",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 60%, transparent)",
    },
  },
});

const recipeStyles = stylex.create({
  pieceViewSpan: {
    fontFamily: "var(--font-pixel)",
    fontWeight: "var(--font-weight-normal)",
  },
  pieceViewSpanVariant1Case1: {
    overflow: null,
  },
  pieceViewSpanVariant1Case2: {
    overflow: "hidden",
  },
  pieceViewSpanVariant2Case1: {
    textAlign: null,
  },
  pieceViewSpanVariant2Case2: {
    textAlign: "center",
  },
});

const variantStyles = stylex.create({
  pixelCardDiv: {
    boxSizing: "border-box",
    display: "flex",
    borderStyle: "solid",
    borderWidth: "2px",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-shade)",
  },
  pixelCardDivVariant: {
    alignItems: "center",
    justifyContent: "center",
  },
  pixelCardDivVariant2: {},
  pixelCardDiv2: {
    display: "flex",
    flexDirection: "column",
  },
  pixelCardDivVariant3: {
    alignItems: "center",
  },
  pixelCardDivVariant4: {
    alignItems: "flex-start",
  },
});

const viewStyles = stylex.create({
  animalFaceImg: {
    position: "absolute",
    maxWidth: "none",
    imageRendering: "pixelated",
  },
  pieceViewImg: {
    flexShrink: "0",
    imageRendering: "pixelated",
  },
  pieceViewSvg: {
    flexShrink: "0",
  },
  pieceViewSpan: {
    position: "relative",
    flexShrink: "0",
  },
  pieceViewSpan2: {
    position: "absolute",
    top: "0",
  },
  pieceViewSpan3: {
    position: "absolute",
    insetBlock: "0",
    left: "0",
  },
  pixelCardDiv: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
  pixelCardDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
  },
});

export const CardColors = {
  ink: "#3a2a18",
  paper: "#f3e2b8",
  muted: "#776046",
  good: "#3f6b2a",
  lightInk: "#fff3dc",
  wood: "#b07a45",
  held: "#b4cb7c",
  slot: "#eedcb2",
  ripe: "#e8b84a",
  bug: "#b44b36",
  stuck: "#4a728c",
  rest: "#cdbb92",
  // Handed back and waiting: on its acceptance, or on the owner's answer.
  wait: "#b4cb7c",
  barFill: "#7ea64f",
  barTrack: "#e2c995",
} as const;

/** A cell of a glyph: x, y, w, h on its grid, and a CSS colour. */
export type GlyphCell = readonly [x: number, y: number, w: number, h: number, color: string];

export type Piece =
  | { kind: "words"; text: string; color?: string; size?: number }
  | { kind: "icon"; sprite: SpriteInfo; px: number }
  | { kind: "glyph"; cells: readonly GlyphCell[]; px: number; grid?: { w: number; h: number } }
  | { kind: "faces"; looks: readonly string[]; atlas: SpriteAtlas; px?: number }
  | { kind: "bar"; fill: number; w: number; h: number; color?: string; track?: string };

/** A plot sign's paper and ink by its tone. */
export const badgeColors: Record<BadgeTone, readonly [paper: string, ink: string]> = {
  ripe: [CardColors.ripe, CardColors.ink],
  bug: [CardColors.bug, CardColors.lightInk],
  stuck: [CardColors.stuck, CardColors.lightInk],
  rest: [CardColors.rest, CardColors.ink],
  wait: [CardColors.wait, CardColors.ink],
};

/** A helper's head, cut from its attention drawing (`<look>-down`, else the bear farmer's), on a leaf green ground. */
export function AnimalFace(props: { atlas: SpriteAtlas; look: string; size: number }) {
  const cut = () => {
    const sp = props.atlas.has(`${props.look}-down`) ? props.atlas.get(`${props.look}-down`) : props.atlas.get("bear-farmer-down");
    const k = props.size / (sp.h * 0.5);
    return { url: sp.url, left: props.size / 2 - (sp.w / 2) * k, top: props.size / 2 - (sp.h * 0.25 + sp.h * 0.03) * k, width: sp.w * k, height: sp.h * k };
  };
  return (
    <span {...stylex.attrs(recipeStyles2.animalFaceSpan)} style={{ width: `${props.size}px`, height: `${props.size}px` }} aria-hidden="true">
      <img
        src={cut().url}
        alt=""
        draggable="false"
        {...stylex.attrs(viewStyles.animalFaceImg)}
        style={{ left: `${cut().left}px`, top: `${cut().top}px`, width: `${cut().width}px`, height: `${cut().height}px` }}
      />
    </span>
  );
}

function PieceView(props: { piece: Piece; ink: string; maxWidth?: number | undefined; maxLines?: number | undefined; center: boolean }) {
  return (
    <Switch>
      <Match when={props.piece.kind === "words" ? props.piece : undefined}>
        {(p) => (
          <span
            {...stylex.attrs(
              recipeStyles.pieceViewSpan,
              props.maxLines !== undefined ? recipeStyles.pieceViewSpanVariant1Case2 : recipeStyles.pieceViewSpanVariant1Case1,
              props.center ? recipeStyles.pieceViewSpanVariant2Case2 : recipeStyles.pieceViewSpanVariant2Case1,
            )}
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
            {...stylex.attrs(viewStyles.pieceViewImg)}
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
              {...stylex.attrs(viewStyles.pieceViewSvg)}
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
            <span {...stylex.attrs(viewStyles.pieceViewSpan)} style={{ width: `${n() === 0 ? 0 : px() + (n() - 1) * (px() - 10)}px`, height: `${px()}px` }}>
              {/* The first is drawn last, on top. */}
              <For each={p().looks} keyed={false}>
                {(look, i) => (
                  <span {...stylex.attrs(viewStyles.pieceViewSpan2)} style={{ left: `${i * (px() - 10)}px`, "z-index": n() - i }}>
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
            <span
              {...stylex.attrs(viewStyles.pieceViewSpan)}
              style={{ width: `${p().w}px`, height: `${p().h}px`, background: p().track ?? CardColors.barTrack }}
            >
              <span
                {...stylex.attrs(viewStyles.pieceViewSpan3)}
                style={{ width: `${Math.round(p().w * steps())}px`, background: p().color ?? CardColors.barFill }}
              />
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
  paper?: string | undefined;
  ink?: string | undefined;
  padX?: number | undefined;
  padY?: number | undefined;
  width?: number;
  height?: number;
  center?: boolean | undefined;
  maxWidth?: number | undefined;
  maxLines?: number | undefined;
}) {
  const centred = () => !(props.center !== true) || props.width !== undefined || props.height !== undefined;
  return (
    <div {...stylex.attrs(viewStyles.pixelCardDiv)}>
      <div
        {...stylex.attrs(variantStyles.pixelCardDiv, centred() ? variantStyles.pixelCardDivVariant : variantStyles.pixelCardDivVariant2)}
        style={{
          background: props.paper ?? CardColors.paper,
          "border-color": CardColors.ink,
          padding: `${props.padY ?? 3}px ${props.padX ?? 6}px`,
          "min-width": props.width !== undefined ? `${props.width}px` : undefined,
          "min-height": props.height !== undefined ? `${props.height}px` : undefined,
        }}
      >
        <div {...stylex.attrs(variantStyles.pixelCardDiv2, props.center === true ? variantStyles.pixelCardDivVariant3 : variantStyles.pixelCardDivVariant4)}>
          <For each={props.rows} keyed={false}>
            {(row) => (
              <div {...stylex.attrs(viewStyles.pixelCardDiv2)}>
                <For each={row()} keyed={false}>
                  {(p) => (
                    <PieceView
                      piece={p()}
                      ink={props.ink ?? CardColors.ink}
                      maxWidth={props.maxWidth}
                      maxLines={props.maxLines}
                      center={!(props.center !== true)}
                    />
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
