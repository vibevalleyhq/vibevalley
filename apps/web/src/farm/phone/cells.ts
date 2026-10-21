import type { GlyphCell } from "../kit/card";

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
  ...(lit ? ([[9, 0, 1, 1, "#c84a3a"]] as GlyphCell[]) : []),
];
