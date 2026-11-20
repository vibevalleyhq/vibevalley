// VibeValley native shell design tokens, aligned with the warm-stone workbench
// palette (apps/mac/ui/vv/theme.json) and GPUI theme (apps/mac/src/theme.rs).
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
  /// Sidebar and inspector background; mirrors theme.rs `surface` and workbench `side`.
  canvas: string;
};

const light: Palette = {
  ink: "#1c1917",
  text: "#4a4540",
  muted: "#5e5852",
  faint: "#716a64",
  surface: "#fcfcfb",
  subtle: "#e7e5e0",
  tile: "#efeeeb",
  border: "#e6e4e0",
  focus: "rgba(77,122,42,0.75)",
  ok: "#3f7329",
  alert: "#b45d0e",
  danger: "#a83a2c",
  codeKey: "#1c1917",
  codeStr: "#1f7a72",
  codeNum: "#a6560c",
  codeLit: "#7e42b8",
  primary: "#1c1917",
  onPrimary: "#fcfcfb",
  canvas: "#f6f5f3",
};

const dark: Palette = {
  ink: "#ecebe8",
  text: "#bbb6af",
  muted: "#a9a49e",
  faint: "#8b867f",
  surface: "#21201d",
  subtle: "#312f2b",
  tile: "#282623",
  border: "rgba(236,235,232,0.11)",
  focus: "rgba(141,187,92,0.8)",
  ok: "#7fae4f",
  alert: "#e5a93c",
  danger: "#e47d6d",
  codeKey: "#ecebe8",
  codeStr: "#5bbfb2",
  codeNum: "#e5a93c",
  codeLit: "#c9a7eb",
  primary: "#ecebe8",
  onPrimary: "#151413",
  canvas: "#1b1a18",
};

/** The palette of the scheme shown now (reactive). */
export function tok(): Palette {
  return colorScheme() === "dark" ? dark : light;
}

const fontMono = "Menlo";

export const type = {
  title: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 13.5, lineHeight: 19 },
  mono: { fontSize: 12.5, fontFamily: fontMono },
  label: { fontSize: 12 },
  code: { fontSize: 12, lineHeight: 19, fontFamily: fontMono },
} as const;

export const radius = { sm: 7, md: 10, lg: 16, button: 9, card: 12, tray: 22 } as const;

/** Card ring: an inset 1 px border ring plus a faint drop in light mode. */
export function cardShadow(p: Palette) {
  return p === dark
    ? [{ x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true }]
    : [
        { x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true },
        { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(28,25,23,0.05)", inset: false },
      ];
}

/** `danger` at 6 % fill with a 16 % ring, for error boxes. */
export function dangerTint(p: Palette) {
  const base = p === dark ? "228,125,109" : "168,58,44";
  return { fill: `rgba(${base},0.06)`, ring: `rgba(${base},0.16)` };
}
