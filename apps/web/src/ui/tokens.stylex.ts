import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineConsts({
  page: "var(--color-page)",
  side: "var(--color-side)",
  rail: "var(--color-rail)",
  onRail: "var(--color-on-rail)",
  ink: "var(--color-ink)",
  muted: "var(--color-muted)",
  faint: "var(--color-faint)",
  line: "var(--color-line)",
  hover: "var(--color-hover)",
  selected: "var(--color-selected)",
  focus: "var(--color-focus)",
  accent: "var(--color-accent)",
  accentHover: "var(--color-accent-hover)",
  leaf: "var(--color-leaf)",
  wheat: "var(--color-wheat)",
  berry: "var(--color-berry)",
  water: "var(--color-water)",
  bark: "var(--color-bark)",
  idle: "var(--color-idle)",
  okSoft: "var(--color-ok-soft)",
  okInk: "var(--color-ok-ink)",
  badSoft: "var(--color-bad-soft)",
  warnInk: "var(--color-warn-ink)",
  scrim: "var(--color-scrim)",
  codeBg: "var(--color-code-bg)",
  codeInk: "var(--color-code-ink)",
});

export const fonts = stylex.defineConsts({
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
  pixel: "var(--font-pixel)",
});

export const text = stylex.defineConsts({
  "2xs": "var(--text-2xs)",
  xs: "var(--text-xs)",
  sm: "var(--text-sm)",
  base: "var(--text-base)",
  lg: "var(--text-lg)",
  xl: "var(--text-xl)",
  "2xl": "var(--text-2xl)",
  "3xl": "var(--text-3xl)",
});

export const leading = stylex.defineConsts({
  "2xs": "var(--leading-2xs)",
  xs: "var(--leading-xs)",
  sm: "var(--leading-sm)",
  base: "var(--leading-base)",
  lg: "var(--leading-lg)",
  xl: "var(--leading-xl)",
  "2xl": "var(--leading-2xl)",
  "3xl": "var(--leading-3xl)",
  snug: "var(--leading-snug)",
  relaxed: "var(--leading-relaxed)",
});

export const radii = stylex.defineConsts({
  xs: "var(--radius-xs)",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  xl: "var(--radius-xl)",
  pill: "9999px",
});

export const shadows = stylex.defineConsts({
  raise: "var(--shadow-raise)",
  float: "var(--shadow-float)",
});

export const easing = stylex.defineConsts({
  out: "var(--ease-out)",
  in: "var(--ease-in)",
  inOut: "var(--ease-in-out)",
  spring: "var(--ease-spring)",
});

export const durations = stylex.defineConsts({
  instant: "0ms",
  pointer: "120ms",
  state: "180ms",
  panel: "280ms",
});

export const containers = stylex.defineConsts({
  sm: "var(--container-sm)",
  md: "var(--container-md)",
  lg: "var(--container-lg)",
  xl: "var(--container-xl)",
  "2xl": "var(--container-2xl)",
  "3xl": "var(--container-3xl)",
  "4xl": "var(--container-4xl)",
});

export const media = stylex.defineConsts({
  hover: "@media (hover: hover)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
  sm: "@media (width >= 40rem)",
  md: "@media (width >= 48rem)",
  lg: "@media (width >= 64rem)",
});
