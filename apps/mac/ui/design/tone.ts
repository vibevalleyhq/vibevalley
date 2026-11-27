// VibeValley tints a tone with CSS `color-mix(in srgb, <tone> N%, transparent)`;
// nsh has no color-mix, so the theme token is read and given an alpha.
import { token } from "nsh";

import { mixHexColor } from "@vibevalley/protocol/ui";

/** The theme color `name` (follows light and dark). */
export const tone = (name: string): string => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- nsh's `token` accepts any dynamic theme key at runtime
  const value = (token as (n: string) => unknown)(name);
  return typeof value === "string" ? value : "#888888";
};

/** `name` at `part` (0..1) over transparent: color-mix(in srgb, name part%, transparent). */
export function mix(name: string, part: number): string {
  return mixHexColor(tone(name), part);
}
