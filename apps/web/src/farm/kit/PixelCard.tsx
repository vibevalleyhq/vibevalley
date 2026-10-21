import type { BadgeTone } from "@vibevalley/protocol";
import type { SpriteAtlas, SpriteInfo } from "../world/sprites";
import { cx } from "./base";

// At screen pixels, so the words stay sharp at any scale.

export const CardColors = {
  ink: "#3a2a18",
  paper: "#f3e2b8",
  muted: "#7a6248",
  good: "#3f6b2a",
  lightInk: "#fff3dc",
  wood: "#b07a45",
  held: "#b4cb7c",
  slot: "#eedcb2",
  ripe: "#e8b84a",
  bug: "#c8543c",
  stuck: "#5d8fb0",
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

/** A helper's head, cut from its standing drawing (`<look>-down`, else the bear farmer's), on a leaf green ground. */
export function AnimalFace({ atlas, look, size }: { atlas: SpriteAtlas; look: string; size: number }) {
  const sp = atlas.has(`${look}-down`) ? atlas.get(`${look}-down`) : atlas.get("bear-farmer-down");
  const k = size / (sp.h * 0.5);
  const cx0 = sp.w / 2;
  const cy0 = sp.h * 0.25 + sp.h * 0.03;
  return (
    <span className="relative inline-block shrink-0 overflow-hidden bg-leaf-300/60" style={{ width: size, height: size }} aria-hidden>
      <img
        src={sp.url}
        alt=""
        draggable={false}
        className="absolute max-w-none [image-rendering:pixelated]"
        style={{ left: size / 2 - cx0 * k, top: size / 2 - cy0 * k, width: sp.w * k, height: sp.h * k }}
      />
    </span>
  );
}

function PieceView({ piece, ink, maxWidth, maxLines, center }: { piece: Piece; ink: string; maxWidth?: number; maxLines?: number; center: boolean }) {
  switch (piece.kind) {
    case "words": {
      const size = piece.size ?? 12;
      return (
        <span
          className={cx("font-pixel font-normal", maxLines !== undefined && "overflow-hidden", center && "text-center")}
          style={{
            fontSize: size,
            lineHeight: `${size + 2}px`,
            color: piece.color ?? ink,
            maxWidth,
            ...(maxLines !== undefined ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: maxLines } : {}),
          }}
        >
          {piece.text}
        </span>
      );
    }
    case "icon":
      return (
        <img
          src={piece.sprite.url}
          alt=""
          draggable={false}
          className="shrink-0 [image-rendering:pixelated]"
          style={{ height: piece.px, width: (piece.px * piece.sprite.w) / piece.sprite.h }}
        />
      );
    case "glyph": {
      const grid = piece.grid ?? { w: 10, h: 16 };
      return (
        <svg
          width={(piece.px * grid.w) / grid.h}
          height={piece.px}
          viewBox={`0 0 ${grid.w} ${grid.h}`}
          shapeRendering="crispEdges"
          className="shrink-0"
          aria-hidden
        >
          {piece.cells.map(([x, y, w, h, c], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} fill={c} />
          ))}
        </svg>
      );
    }
    case "faces": {
      const px = piece.px ?? 22;
      const n = piece.looks.length;
      return (
        <span className="relative shrink-0" style={{ width: n === 0 ? 0 : px + (n - 1) * (px - 10), height: px }}>
          {/* The first is drawn last, on top. */}
          {piece.looks.map((look, i) => (
            <span key={i} className="absolute top-0" style={{ left: i * (px - 10), zIndex: n - i }}>
              <AnimalFace atlas={piece.atlas} look={look} size={px} />
            </span>
          ))}
        </span>
      );
    }
    case "bar": {
      // Whole twentieths, so the fill moves in steps.
      const steps = Math.round(Math.min(1, Math.max(0, piece.fill)) * 20) / 20;
      return (
        <span className="relative shrink-0" style={{ width: piece.w, height: piece.h, background: piece.track ?? CardColors.barTrack }}>
          <span className="absolute inset-y-0 left-0" style={{ width: Math.round(piece.w * steps), background: piece.color ?? CardColors.barFill }} />
        </span>
      );
    }
  }
}

/** A HUD sign: rows of pieces 3 px apart on paper with an ink border and a hard drop. `width` and `height` include the border. */
export function PixelCard({
  rows,
  paper = CardColors.paper,
  ink = CardColors.ink,
  padX = 6,
  padY = 3,
  width,
  height,
  center = false,
  maxWidth,
  maxLines,
}: {
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
  const centred = center || width !== undefined || height !== undefined;
  return (
    <div className="inline-block pr-0.5 pb-0.5">
      <div
        className={cx("box-border flex border-2 shadow-[2px_2px_0_0_#3a2a1899]", centred && "items-center justify-center")}
        style={{ background: paper, borderColor: CardColors.ink, padding: `${padY}px ${padX}px`, minWidth: width, minHeight: height }}
      >
        <div className={cx("flex flex-col", center ? "items-center" : "items-start")}>
          {rows.map((row, r) => (
            <div key={r} className="flex items-center gap-[3px]">
              {row.map((p, i) => (
                <PieceView key={i} piece={p} ink={ink} maxWidth={maxWidth} maxLines={maxLines} center={center} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A plot sign's paper and ink by its tone. */
export const badgeColors: Record<BadgeTone, readonly [paper: string, ink: string]> = {
  ripe: [CardColors.ripe, CardColors.ink],
  bug: [CardColors.bug, CardColors.lightInk],
  stuck: [CardColors.stuck, CardColors.lightInk],
  rest: [CardColors.rest, CardColors.ink],
  wait: [CardColors.wait, CardColors.ink],
};
