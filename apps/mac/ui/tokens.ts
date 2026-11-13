// VibeValley design tokens (docs/design/components.md section 2), mirroring
// affectUI's --aui-* variables. The GPUI side keeps the same values in
// apps/mac/src/theme.rs.
import { colorScheme } from "nsh";

export type Palette = {
  ink: string;
  text: string;
  muted: string;
  faint: string;
  surface: string;
  subtle: string;
  tile: string;
  border: string;
  focus: string;
  ok: string;
  alert: string;
  danger: string;
  codeKey: string;
  codeStr: string;
  codeNum: string;
  codeLit: string;
  /// Primary button fill (the dark gradient's base; inverted in dark mode).
  primary: string;
  onPrimary: string;
  /// Pane background behind cards; matches the terminal background.
  canvas: string;
};

export const light: Palette = {
  ink: "#171717",
  text: "#6b6b6b",
  muted: "#8a8a8a",
  faint: "#b5b5b5",
  surface: "#ffffff",
  subtle: "#f0f0f0",
  tile: "#f5f5f5",
  border: "#e7e7e7",
  focus: "rgba(0,96,226,0.7)",
  ok: "#1e8a4f",
  alert: "#e6730e",
  danger: "#c4320a",
  codeKey: "#171717",
  codeStr: "#0b8576",
  codeNum: "#b25e00",
  codeLit: "#8a35d6",
  primary: "#1f1f1f",
  onPrimary: "#ffffff",
  canvas: "#fafafa",
};

export const dark: Palette = {
  ink: "#ededed",
  text: "#a1a1a1",
  muted: "#7c7c7c",
  faint: "#6b6b70",
  surface: "#161618",
  subtle: "#232326",
  tile: "#1d1d20",
  border: "rgba(255,255,255,0.10)",
  focus: "rgba(77,141,255,0.8)",
  ok: "#41bd74",
  alert: "#f28a2e",
  danger: "#ff8a7a",
  codeKey: "#ededed",
  codeStr: "#4fc3b4",
  codeNum: "#f2a15c",
  codeLit: "#cfaef5",
  primary: "#ededed",
  onPrimary: "#161618",
  canvas: "#111113",
};

/** The palette of the scheme shown now (reactive). */
export function tok(): Palette {
  return colorScheme() === "dark" ? dark : light;
}

export const font = "Inter";
export const fontMono = "Menlo";

export const type = {
  title: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 13.5, lineHeight: 19 },
  mono: { fontSize: 12.5, fontFamily: fontMono },
  label: { fontSize: 12 },
  code: { fontSize: 12, lineHeight: 19, fontFamily: fontMono },
} as const;

export const radius = { sm: 7, md: 10, lg: 16, button: 9, card: 12, tray: 22 } as const;

export const hit = { row: 44, groupHead: 36, button: 30, icon: 24 } as const;

/** Card ring: an inset 1 px border ring plus a faint drop in light mode. */
export function cardShadow(p: Palette) {
  return p === dark
    ? [{ x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true }]
    : [
        { x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true },
        { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0,0,0,0.04)", inset: false },
      ];
}

/** `danger` at 6 % fill with a 16 % ring, for error boxes. */
export function dangerTint(p: Palette) {
  const base = p === dark ? "255,138,122" : "196,50,10";
  return { fill: `rgba(${base},0.06)`, ring: `rgba(${base},0.16)` };
}
