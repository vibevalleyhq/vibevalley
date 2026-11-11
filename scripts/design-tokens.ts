export type TokenKind = "radius" | "type" | "motion" | "layer" | "disabled" | "shadow";

const durations = new Set([0, 120, 180, 280]);
const layers = new Set([0, 10, 20, 30, 40]);
const globalValues = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const radius = /^(?:0(?:px)?|50%|9999px|2147483647px|var\(--radius-(?:xs|sm|md|lg|xl)\))$/u;
const typeSize = /^var\(--text-(?:2xs|xs|sm|base|lg|xl|2xl|3xl)\)$/u;
const easing = /^var\(--(?:ease-(?:out|in|in-out|spring)|default-transition-timing-function)\)$/u;
const palette = /var\(--(?:color|shadow)-[\w-]+\s*[,)]|\bcurrentcolor\b/iu;

function duration(value: string): boolean {
  if (value === "var(--default-transition-duration)") return true;
  const match = /^(\d*\.?\d+)(ms|s)?$/u.exec(value);
  return !!match && durations.has(Number(match[1]) * (match[2] === "s" ? 1000 : 1));
}

/** Geometry is not a design ladder: coordinates, sizes and animation paths belong to their scene. */
export function offTokens(property: string, value: string | number, disabled = false): TokenKind | undefined {
  const text = String(value).trim();
  if (globalValues.has(text)) return undefined;
  if (/^border(?:TopLeft|TopRight|BottomLeft|BottomRight|StartStart|StartEnd|EndStart|EndEnd)?Radius$/u.test(property)) {
    if (text === "calc(infinity * 1px)") return undefined;
    return text.split(/[\s/]+/u).every((part) => radius.test(part)) ? undefined : "radius";
  }
  if (property === "fontSize") return typeSize.test(text) ? undefined : "type";
  if (property === "transitionDuration" || property === "transitionDelay") {
    return text.split(",").every((part) => duration(part.trim())) ? undefined : "motion";
  }
  if (property === "transitionTimingFunction") return text.split(",").every((part) => easing.test(part.trim())) ? undefined : "motion";
  if (property === "transition") return text === "none" ? undefined : "motion";
  if (property === "zIndex") return text === "auto" || layers.has(Math.abs(Number(text))) ? undefined : "layer";
  if (property === "opacity" && disabled) return Number(text) === 0.5 ? undefined : "disabled";
  if (property === "boxShadow") return text === "none" || palette.test(text) ? undefined : "shadow";
  return undefined;
}

export const tokenAdvice: Record<TokenKind, string> = {
  radius: "a named corner such as borderRadius: 'var(--radius-md)' (xs/sm/md/lg/xl); 0 for square corners or '9999px' for pills",
  type: "fontSize: 'var(--text-sm)' from the host's named type tokens (2xs through 3xl); reserve 2xl/3xl for document titles and pairing codes",
  motion:
    "transition longhands with 120ms (hover/press), 180ms (state), 280ms (panel), or 0; transitionTimingFunction: 'var(--ease-out)' (in/in-out/spring for other motion)",
  layer: "zIndex: 10 (on content), 20 (panel), 30 (menu/popover/tip), or 40 (toast)",
  disabled: "opacity: { default: null, ':disabled': 0.5 }, the one disabled look",
  shadow: "boxShadow: 'var(--shadow-raise)' or 'var(--shadow-float)'; an inset line uses var(--color-accent)",
};

/** URL fragments identify assets, not colours; content and arbitrary business strings are not paint. */
export function hexColor(property: string | undefined, value: string): boolean {
  if (
    property !== undefined &&
    !property.startsWith("--") &&
    !/^(?:.*Color|color|background(?:Image)?|maskImage|border(?:Top|Right|Bottom|Left|Block|Inline|BlockStart|BlockEnd|InlineStart|InlineEnd)?|outline|boxShadow|textShadow|fill|stroke|filter|backdropFilter|textDecoration|columnRule)$/u.test(
      property,
    )
  )
    return false;
  return /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/iu.test(value.replace(/url\([^)]*\)/giu, ""));
}
