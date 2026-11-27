/** Shared tiered motion durations (ms) enforced across desktop (`apps/mac/ui`) and mobile (`apps/mobile`). */
export type MotionTier = "fast" | "normal" | "slow";

export const MOTION_DURATIONS: Readonly<Record<MotionTier, number>> = {
  fast: 120,
  normal: 180,
  slow: 280,
};

export const MOTION_ENTER_CLASSES: Readonly<Record<MotionTier, string>> = {
  fast: "transition-transform duration-120 ease-out",
  normal: "transition-opacity duration-180 ease-out",
  slow: "transition-opacity duration-280 ease-out",
};

/** Shared tactile press transition class (always gated through `motionClass`). */
export const TACTILE_PRESS_CLASS = "transition-transform duration-120 ease-out active:translate-y-px";

/** Default semantic tones for status icons when callers omit both `color` and `tone`. */
const DEFAULT_ICON_TONES: Readonly<Record<string, string>> = {
  check: "leaf",
  cross: "berry",
  warn: "wheat",
};

/** Tints a `#RRGGBB` or `#RRGGBBAA` hex color at `part` (0..1) over transparent (`rgba(...)`). */
export function mixHexColor(color: string, part: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6 && hex.length !== 8) return color;
  const rgb = Number.parseInt(hex.slice(0, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  return `rgba(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255},${(alpha * part).toFixed(3)})`;
}

/** Resolves an icon's hex color: explicit `color`, explicit `tone`, semantic fallback (`DEFAULT_ICON_TONES`), or `"ink"`. */
export function resolveIconColorHex(
  opts: { readonly name: string; readonly color?: string | undefined; readonly tone?: string | undefined },
  lookupTone: (name: string) => string,
): string {
  if (opts.color !== undefined) return opts.color;
  if (opts.tone !== undefined) return lookupTone(opts.tone);
  return lookupTone(DEFAULT_ICON_TONES[opts.name] ?? "ink");
}
