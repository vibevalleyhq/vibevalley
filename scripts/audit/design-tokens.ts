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
  radius: "a named corner: rounded-md (xs/sm/md/lg/xl) in `class`, or var(--radius-md) in a style; 0 for square corners or rounded-full for pills",
  type: "the type ladder: text-sm in `class` (2xs through 3xl), or var(--text-sm) in a style; reserve 2xl/3xl for document titles and pairing codes",
  motion:
    "120ms (hover/press), 180ms (state), 280ms (panel) or 0: duration-120 in `class`; ease-out (in/in-out/spring for other motion), or var(--ease-out) in a style",
  layer: "z-10 (on content), z-20 (panel), z-30 (menu/popover/tip) or z-40 (toast)",
  disabled: "disabled:opacity-50, the one disabled look",
  shadow: "shadow-raise or shadow-float (var(--shadow-raise), var(--shadow-float) in a style); an inset line uses var(--color-accent)",
};

/** URL fragments identify assets, not colours; content and arbitrary business strings are not paint. */
export function hexColor(property: string | undefined, value: string): boolean {
  // A JSX style object may name the property as CSS does (box-shadow); the list below is camelCase.
  const name = property?.startsWith("--") === true ? property : property?.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
  if (
    name !== undefined &&
    !name.startsWith("--") &&
    !/^(?:.*Color|color|background(?:Image)?|maskImage|border(?:Top|Right|Bottom|Left|Block|Inline|BlockStart|BlockEnd|InlineStart|InlineEnd)?|outline|boxShadow|textShadow|fill|stroke|filter|backdropFilter|textDecoration|columnRule)$/u.test(
      name,
    )
  )
    return false;
  return /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/iu.test(value.replace(/url\([^)]*\)/giu, ""));
}

/** What a Tailwind class can get wrong: a token's ladder, the spacing ladder, or a colour with no name. */
export type ClassKind = TokenKind | "spacing" | "hex";

const spacingUtility = /^(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])$/u;
const radiusUtility = /^rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|es|ee))?$/u;
const length = /^-?(?:\d*\.?\d+(?:px|rem|em)|calc\(.*\)|clamp\(.*\)|min\(.*\)|max\(.*\))$/u;
const hex = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/iu;
const spacingProperty = /^(?:padding|margin|gap|rowGap|columnGap)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?$/u;

/** Splits a class on the `:` that end its variants, not on one inside brackets (`data-[state=open]:`, `[&:hover]:`). */
function classParts(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

function classKind(token: string): ClassKind | undefined {
  const parts = classParts(token);
  const utility = (parts.pop() ?? "").replace(/^!|!$/gu, "").replace(/^-/u, "");
  const disabled = parts.some((variant) => /(?:^|-)disabled$/u.test(variant));
  const property = /^\[([a-z-]+):(.+)\]$/u.exec(utility);
  if (property) {
    const [, css = "", raw = ""] = property;
    const value = raw.replaceAll("_", " ");
    if (hex.test(value.replace(/url\([^)]*\)/giu, ""))) return "hex";
    const name = css.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    if (spacingProperty.test(name) && !value.startsWith("var(")) return "spacing";
    return offTokens(name, value, disabled);
  }
  const arbitrary = /^([a-z][a-z\d-]*?)-\[(?:[a-z-]+:)?(.+)\]$/u.exec(utility);
  if (arbitrary) {
    const [, name = "", raw = ""] = arbitrary;
    const value = raw.replaceAll("_", " ");
    if (hex.test(value.replace(/url\([^)]*\)/giu, ""))) return "hex";
    if (name === "text" || name === "leading") return length.test(value) ? "type" : undefined;
    if (radiusUtility.test(name)) return offTokens("borderRadius", value);
    if (name === "z") return offTokens("zIndex", value);
    if (name === "duration" || name === "delay") return offTokens("transitionDuration", value);
    if (name === "ease") return offTokens("transitionTimingFunction", value);
    if (name === "shadow") return offTokens("boxShadow", value);
    if (spacingUtility.test(name)) return value.startsWith("var(") ? undefined : "spacing";
    return undefined;
  }
  const numeric = /^(z|duration|delay|opacity)-(\d+)$/u.exec(utility);
  if (numeric) {
    const [, name = "", value = ""] = numeric;
    if (name === "z") return offTokens("zIndex", value);
    if (name === "opacity") return disabled ? offTokens("opacity", String(Number(value) / 100), true) : undefined;
    return offTokens("transitionDuration", value);
  }
  return undefined;
}

/**
 * The classes in a string that bypass the tokens: arbitrary values (`p-[7px]`, `text-[13px]`, `bg-[#abc]`, `[font-size:13px]`)
 * and numbers off a ladder (`z-15`, `duration-150`, `disabled:opacity-40`). Tailwind reads every string in the source as
 * possible classes, so every string is read here too.
 */
export function offClassTokens(text: string): { token: string; kind: ClassKind }[] {
  const found: { token: string; kind: ClassKind }[] = [];
  for (const token of text.split(/\s+/u)) {
    if (token === "" || !/^[!@\w[-]/u.test(token)) continue;
    const kind = classKind(token);
    if (kind) found.push({ token, kind });
  }
  return found;
}

export const classAdvice: Record<ClassKind, string> = {
  radius: "a named corner: rounded-xs, rounded-sm, rounded-md, rounded-lg, rounded-xl, rounded-full for a pill, or rounded-none",
  type: "the type ladder: text-2xs, text-xs, text-sm, text-base, text-lg, text-xl (each brings its line height); leading-xs… to change only the line height",
  motion: "duration-120 (hover/press), duration-180 (state), duration-280 (panel) or duration-0; ease-out (in, in-out, spring for other motion)",
  layer: "z-10 (on content), z-20 (panel), z-30 (menu/popover/tip) or z-40 (toast)",
  disabled: "disabled:opacity-50, the one disabled look",
  shadow: "shadow-raise or shadow-float; an inset line is inset-ring-1 inset-ring-accent",
  spacing: "the 4px ladder: p-1 is 4px, p-1.5 6px, p-2.5 10px (any multiple of 0.25 works: p-1.25 is 5px); a length worked out at run time goes in style",
  hex: "the palette's utility such as bg-page, text-muted, border-line, or a tint like bg-wheat/25; a new purpose gets a name in style.css, in both themes",
};
