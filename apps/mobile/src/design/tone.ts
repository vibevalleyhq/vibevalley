import { colorScheme } from "nsh";

import { mixHexColor } from "@vibevalley/protocol/ui";

import themeJson from "../../design/theme.json";

const lightTokens: Readonly<Record<string, string>> = themeJson.cssVars.light;
const darkTokens: Readonly<Record<string, string>> = themeJson.cssVars.dark;
const baseTokens: Readonly<Record<string, string>> = themeJson.cssVars.theme;

/** Resolves a semantic or paper theme token hex color following the active color scheme. */
export function tone(name: string): string {
  const scheme = colorScheme();
  const palette = scheme === "dark" ? darkTokens : lightTokens;
  return palette[name] ?? lightTokens[name] ?? baseTokens[name] ?? "#888888";
}

/** Tints a theme token at `part` (0..1) over transparent. */
export function mix(name: string, part: number): string {
  return mixHexColor(tone(name), part);
}
