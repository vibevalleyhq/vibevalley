import type { GlyphCell } from "@/ui/pixel/card";

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

/** A small picture from rows of characters: `#` is ink, `+` dark, `.` light, anything else nothing. */
export function drawPattern(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number) {
  const fill: Readonly<Record<string, string>> = { "#": lcd.ink, "+": lcd.dark, ".": lcd.light };
  const ox = Math.round(x);
  const oy = Math.round(y);
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = fill[row[dx]!];
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
