import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineConsts({
  cream: "var(--color-cream-100)",
  creamSoft: "var(--color-cream-50)",
  creamHover: "var(--color-cream-hover)",
  rim: "var(--color-rim)",
  bark: "var(--color-bark-900)",
  barkMid: "var(--color-bark-600)",
  leaf: "var(--color-leaf-500)",
  leafHover: "var(--color-leaf-hover)",
  wheat: "var(--color-wheat)",
  wheatHover: "var(--color-wheat-hover)",
  berry: "var(--color-berry)",
  water: "var(--color-water)",
  warn: "var(--color-warn)",
  dusk: "var(--color-dusk)",
  drop: "var(--color-drop)",
});

export const fonts = stylex.defineConsts({
  pixel: "var(--font-pixel)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
});

export const text = stylex.defineConsts({
  xs: "var(--text-xs)",
  sm: "var(--text-sm)",
  base: "var(--text-base)",
  lg: "var(--text-lg)",
  xl: "var(--text-xl)",
  "2xl": "var(--text-2xl)",
  "3xl": "var(--text-3xl)",
  "4xl": "var(--text-4xl)",
});

export const leading = stylex.defineConsts({
  xs: "var(--leading-xs)",
  sm: "var(--leading-sm)",
  base: "var(--leading-base)",
  lg: "var(--leading-lg)",
  xl: "var(--leading-xl)",
  "2xl": "var(--leading-2xl)",
  snug: "var(--leading-snug)",
});

export const shadows = stylex.defineConsts({
  small: "var(--shadow-hard-sm)",
  medium: "var(--shadow-hard)",
  large: "var(--shadow-hard-lg)",
});

export const media = stylex.defineConsts({
  hover: "@media (hover: hover)",
  motionOk: "@media (prefers-reduced-motion: no-preference)",
  sm: "@media (width >= 40rem)",
  md: "@media (width >= 48rem)",
  lg: "@media (width >= 64rem)",
});
