import type { CanvasRenderingContext2D } from "nsh";

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
export function drawPattern(ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">, rows: readonly string[], x: number, y: number) {
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
