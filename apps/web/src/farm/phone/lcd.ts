import type { GlyphCell } from "#/ui/pixel/PixelCard.tsx";

// The phone's screen: four greens, like an old handheld's. The handset and the games draw
// with these.

export const lcd = {
  paper: "#c9dc9a",
  light: "#b9cf8c",
  mid: "#6f8f45",
  dark: "#3d5a2a",
  ink: "#22341a",
  pale: "#e8f0c8",
  paleHover: "#f2f7dc",
  rule: "#9fb07a",
} as const;

/** A number in [0, 1) and the next seed. mulberry32 in 32-bit integer arithmetic, so a seed always deals the same pieces
 * and obstacles. */
export function nextRandom(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** A small picture from rows of characters: `#` is ink, `+` dark, `.` light, anything else nothing. */
export function drawPattern(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number) {
  const fill: Readonly<Record<string, string>> = { "#": lcd.ink, "+": lcd.dark, ".": lcd.light };
  const ox = Math.round(x);
  const oy = Math.round(y);
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx];
      const c = ch === undefined ? undefined : fill[ch];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(ox + dx, oy + dy, 1, 1);
    }
  });
}

/** The phone, drawn in cells on a 10 × 16 grid; lit while it rings. */
export const phoneCells = (lit: boolean): GlyphCell[] => [
  [1, 0, 8, 16, "#2f1f13"],
  [2, 1, 6, 14, "#67482d"],
  [3, 2, 4, 5, lit ? "#b4e07a" : "#9fb07a"],
  [3, 9, 1, 1, "#e2c995"],
  [5, 9, 1, 1, "#e2c995"],
  [3, 11, 1, 1, "#e2c995"],
  [5, 11, 1, 1, "#e2c995"],
  [3, 13, 3, 1, "#e2c995"],
  [8, 1, 1, 3, "#2f1f13"],
  ...(lit ? ([[9, 0, 1, 1, "#c84a3a"]] satisfies GlyphCell[]) : []),
];
