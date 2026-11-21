// VibeValley tints a tone with CSS `color-mix(in srgb, <tone> N%, transparent)`;
// nsh has no color-mix, so the theme token is read and given an alpha.
import { token } from "nsh";

/** The theme color `name` (follows light and dark). */
export const tone = (name: string): string => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- nsh's `token` accepts any dynamic theme key at runtime
  const value = (token as (n: string) => unknown)(name);
  return typeof value === "string" ? value : "#888888";
};

/** `name` at `part` (0..1) over transparent: color-mix(in srgb, name part%, transparent). */
export function mix(name: string, part: number): string {
  const c = tone(name);
  const hex = c.startsWith("#") ? c.slice(1) : "";
  if (hex.length !== 6 && hex.length !== 8) return c;
  const n = parseInt(hex.slice(0, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${(a * part).toFixed(3)})`;
}
