// Words and buttons over a pixel stage, drawn by the stage itself in its ui layer (screen pixels, so words stay
// sharp at any scale): cards (a box with a hard outline and a drop, rows of text and icons), text in the game's pixel
// font, wrapped by characters so Chinese wraps, and hit regions that take the pointer and the keyboard. Pixi's
// accessibility layer gives every hit region a button of its own for Tab and screen readers. A card is laid out
// again only when what it shows changed, so cards can be told what to show every frame.

import { CanvasTextMetrics, Container, Graphics, Rectangle, Sprite, Text, TextStyle, type FederatedPointerEvent, type Texture } from "pixi.js";

export interface Theme {
  /** The pixel font's family; its size in pixels (draw it at that size, or a whole multiple, to keep it crisp). */
  readonly font: string;
  readonly size: number;
  readonly ink: number;
  readonly paper: number;
  /** The outline around a card, and the colour of its drop. */
  readonly edge: number;
  readonly drop: number;
}

/** A part of a row: words, an icon this many pixels tall, or a bar filled `bar` of the way (0..1), in steps of 5%. */
export type Piece =
  | { readonly text: string; readonly color?: number; readonly size?: number }
  | { readonly icon: Texture; readonly px: number }
  | { readonly bar: number; readonly w: number; readonly h: number; readonly color: number; readonly track: number };

export interface CardSpec {
  readonly rows: readonly (readonly Piece[])[];
  readonly paper?: number;
  readonly ink?: number;
  /** A row of words wraps past this many pixels. */
  readonly maxWidth?: number;
  /** A wrapped row keeps this many lines; the last ends in an ellipsis. */
  readonly maxLines?: number;
  readonly align?: "left" | "center";
  readonly padX?: number;
  readonly padY?: number;
  /** At least this wide and tall, pixels (border included): HUD parts of one row share a size. The content is centered. */
  readonly width?: number;
  readonly height?: number;
}

export interface Card {
  readonly node: Container;
  /** Shows `spec`, or hides the card. */
  readonly show: (spec: CardSpec | null) => void;
  /** Its size as laid out now, pixels. */
  readonly size: () => { readonly w: number; readonly h: number };
}

const BORDER = 2;
const DROP = 2;
const GAP = 3;

/** The lines `text` takes at `maxWidth`, broken between characters; at most `maxLines`, the last ending in "…". */
export function wrapLines(text: string, style: TextStyle, maxWidth: number, maxLines = Infinity): string[] {
  const width = (s: string) => CanvasTextMetrics.measureText(s, style).width;
  const lines: string[] = [];
  let line = "";
  for (const ch of text.replace(/\s+/gu, " ")) {
    if (line && width(line + ch) > maxWidth) {
      lines.push(line.trimEnd());
      line = ch === " " ? "" : ch;
    } else line += ch;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] ?? "";
  while (last && width(`${last}…`) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** What a spec looks like, to tell when it changed. */
const keyOf = (spec: CardSpec) => JSON.stringify(spec, (k, v: unknown) => (k === "icon" && typeof v === "object" && v !== null && "uid" in v ? v.uid : v));

export function card(theme: Theme): Card {
  const node = new Container();
  node.visible = false;
  let shown = "";
  let w = 0;
  let h = 0;
  const show = (spec: CardSpec | null) => {
    if (!spec) {
      node.visible = false;
      return;
    }
    node.visible = true;
    const key = keyOf(spec);
    if (key === shown) return;
    shown = key;
    for (const child of node.removeChildren()) child.destroy({ children: true });
    const padX = spec.padX ?? 6;
    const padY = spec.padY ?? 3;
    const lineHeight = theme.size + 2;
    const content = new Container();
    let y = 0;
    let widest = 0;
    const rows: { row: Container; width: number }[] = [];
    for (const pieces of spec.rows) {
      // One row: its pieces side by side, middles lined up; a lone run of words wraps.
      const row = new Container();
      let x = 0;
      let tall = lineHeight;
      const parts: { part: Container; h: number }[] = [];
      for (const piece of pieces) {
        if ("icon" in piece) {
          const icon = new Sprite(piece.icon);
          icon.height = piece.px;
          icon.scale.x = icon.scale.y;
          parts.push({ part: icon, h: piece.px });
          tall = Math.max(tall, piece.px);
          continue;
        }
        if ("bar" in piece) {
          const filled = Math.round(Math.max(0, Math.min(1, piece.bar)) * 20) / 20;
          const bar = new Graphics().rect(0, 0, piece.w, piece.h).fill(piece.track);
          if (filled > 0) bar.rect(0, 0, Math.round(piece.w * filled), piece.h).fill(piece.color);
          parts.push({ part: bar, h: piece.h });
          tall = Math.max(tall, piece.h);
          continue;
        }
        const style = new TextStyle({ fontFamily: theme.font, fontSize: piece.size ?? theme.size, fill: piece.color ?? spec.ink ?? theme.ink });
        const lines =
          spec.maxWidth != null && spec.maxWidth !== 0 && pieces.length === 1 ? wrapLines(piece.text, style, spec.maxWidth, spec.maxLines) : [piece.text];
        const block = new Container();
        lines.forEach((line, i) => {
          const t = new Text({ text: line, style, roundPixels: true });
          t.y = i * lineHeight;
          if (spec.align === "center" && lines.length > 1)
            t.x = Math.round((Math.max(...lines.map((l) => CanvasTextMetrics.measureText(l, style).width)) - t.width) / 2);
          block.addChild(t);
        });
        parts.push({ part: block, h: lines.length * lineHeight });
        tall = Math.max(tall, lines.length * lineHeight);
      }
      for (const { part, h: ph } of parts) {
        part.position.set(x, Math.round((tall - ph) / 2));
        row.addChild(part);
        x += Math.ceil(part.width) + GAP;
      }
      row.y = y;
      y += tall;
      const width = Math.max(0, x - GAP);
      widest = Math.max(widest, width);
      rows.push({ row, width });
      content.addChild(row);
    }
    if (spec.align === "center") for (const { row, width } of rows) row.x = Math.round((widest - width) / 2);
    w = Math.max(spec.width ?? 0, widest + padX * 2 + BORDER * 2);
    h = Math.max(spec.height ?? 0, y + padY * 2 + BORDER * 2);
    const box = new Graphics()
      .rect(DROP, DROP, w, h)
      .fill({ color: theme.drop, alpha: 0.6 })
      .rect(0, 0, w, h)
      .fill(theme.edge)
      .rect(BORDER, BORDER, w - BORDER * 2, h - BORDER * 2)
      .fill(spec.paper ?? theme.paper);
    content.position.set(spec.align === "center" ? Math.round((w - widest) / 2) : BORDER + padX, Math.round((h - y) / 2));
    node.addChild(box, content);
  };
  return { node, show, size: () => ({ w, h }) };
}

/** Puts `node` (of size `w` by `h`) at a screen point: `ax`, `ay` say which of its points sits there (0.5, 1: its bottom middle). */
export function pin(node: Container, at: { x: number; y: number }, w: number, h: number, ax = 0.5, ay = 1) {
  node.position.set(Math.round(at.x - w * ax), Math.round(at.y - h * ay));
}

export interface HitHandlers {
  /** What it is, for screen readers and the keyboard. */
  readonly label: string;
  readonly onTap: (e: FederatedPointerEvent) => void;
  readonly onOver?: () => void;
  readonly onOut?: () => void;
  readonly onDown?: () => void;
  readonly onUp?: () => void;
}

export interface HitRegion {
  readonly node: Container;
  /** Puts it over a box on the screen, pixels. */
  readonly place: (x: number, y: number, w: number, h: number) => void;
  readonly hide: () => void;
  /** Names it again (the label changed). */
  readonly relabel: (label: string) => void;
}

/**
 * An area of the screen that takes the pointer and the keyboard, drawing nothing: the game draws what it stands for.
 * A tap on it goes no further (the ground under it does not take it too). Focus by keyboard counts as the pointer
 * being over it.
 */
export function hitRegion(parent: Container, h: HitHandlers): HitRegion {
  const node = new Container();
  node.eventMode = "static";
  node.cursor = "inherit";
  node.accessible = true;
  node.accessibleType = "button";
  // The title is the tooltip, the hint the button's aria-label.
  node.accessibleTitle = h.label;
  node.accessibleHint = h.label;
  node.tabIndex = 0;
  const area = new Rectangle(0, 0, 0, 0);
  node.hitArea = area;
  // A mouse sends pointer and mouse events alike; the keyboard (the accessibility layer) only mouse ones.
  const over = () => h.onOver?.();
  const out = () => h.onOut?.();
  node.on("pointerover", over);
  node.on("mouseover", over);
  node.on("pointerout", out);
  node.on("mouseout", out);
  node.on("pointerdown", () => h.onDown?.());
  node.on("pointerup", () => h.onUp?.());
  node.on("pointertap", (e) => {
    e.stopPropagation();
    h.onTap(e);
  });
  parent.addChild(node);
  return {
    node,
    place: (x, y, w, hh) => {
      node.visible = true;
      node.position.set(Math.round(x), Math.round(y));
      area.width = Math.round(w);
      area.height = Math.round(hh);
    },
    hide: () => {
      node.visible = false;
    },
    relabel: (label) => {
      if (label === node.accessibleHint) return;
      node.accessibleTitle = label;
      node.accessibleHint = label;
      // Pixi reads the label only as it makes the button; one already made is told here.
      const div = node._accessibleDiv;
      if (div) {
        div.title = label;
        div.setAttribute("aria-label", label);
      }
    },
  };
}
