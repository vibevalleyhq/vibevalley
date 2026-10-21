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
