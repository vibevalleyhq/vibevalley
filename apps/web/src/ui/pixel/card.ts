// At screen pixels, so the words stay sharp at any scale.

import type { BadgeTone } from "@vibevalley/protocol";
import type { SpriteAtlas, SpriteInfo } from "./atlas";

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
