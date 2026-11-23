import { colorScheme } from "nsh";

import themeJson from "../../design/theme.json";

const lightTokens: Readonly<Record<string, string>> = themeJson.cssVars.light;
const darkTokens: Readonly<Record<string, string>> = themeJson.cssVars.dark;
const baseTokens: Readonly<Record<string, string>> = themeJson.cssVars.theme;

/** Resolves a semantic or pixel token hex color following the active color scheme. */
export function tone(name: string): string {
  const scheme = colorScheme();
  const palette = scheme === "dark" ? darkTokens : lightTokens;
  return palette[name] ?? lightTokens[name] ?? baseTokens[name] ?? "#888888";
}

/** Tints a theme token at `part` (0..1) over transparent. */
export function mix(name: string, part: number): string {
  const color = tone(name);
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6 && hex.length !== 8) return color;
  const rgb = Number.parseInt(hex.slice(0, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${(alpha * part).toFixed(3)})`;
}
