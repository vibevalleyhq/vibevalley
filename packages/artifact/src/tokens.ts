import { z } from "zod";

const ThemedString = z.union([z.string(), z.record(z.string(), z.string())]);

const ColorTokenSchema = z.object({
  id: z.string(),
  group: z.exactOptional(z.string()),
  note: z.exactOptional(z.string()),
  value: ThemedString,
});

const TypeFamilySchema = z.object({
  id: z.string(),
  value: z.string(),
  note: z.exactOptional(z.string()),
});

const TypeScaleItemSchema = z.object({
  id: z.string(),
  value: z.string(),
});

const TypeStyleSchema = z.object({
  id: z.string(),
  family: z.string(),
  size: z.string(),
  weight: z.union([z.number(), z.string()]),
  lineHeight: z.exactOptional(z.union([z.number(), z.string()])),
  letterSpacing: z.exactOptional(z.string()),
  sample: z.exactOptional(z.string()),
});

const SimpleTokenSchema = z.object({
  id: z.string(),
  value: ThemedString,
  note: z.exactOptional(z.string()),
});

const TokensSpecSchema = z.object({
  themes: z.exactOptional(z.array(z.string())),
  defaultTheme: z.exactOptional(z.string()),
  color: z.exactOptional(z.array(ColorTokenSchema)),
  type: z.exactOptional(
    z.object({
      families: z.exactOptional(z.array(TypeFamilySchema)),
      scale: z.exactOptional(z.array(TypeScaleItemSchema)),
      styles: z.exactOptional(z.array(TypeStyleSchema)),
    }),
  ),
  space: z.exactOptional(z.array(SimpleTokenSchema)),
  radius: z.exactOptional(z.array(SimpleTokenSchema)),
  shadow: z.exactOptional(z.array(SimpleTokenSchema)),
  border: z.exactOptional(z.array(SimpleTokenSchema)),
  motion: z.exactOptional(z.array(SimpleTokenSchema)),
});

export interface ParsedColorSwatch {
  readonly id: string;
  readonly group: string;
  readonly light: string;
  readonly dark: string;
  readonly note: string;
}

export interface ParsedTypeStyle {
  readonly id: string;
  readonly family: string;
  readonly size: string;
  readonly weight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly sample: string;
}

export interface ParsedTokensSpec {
  readonly themes: readonly string[];
  readonly defaultTheme: string;
  readonly colors: readonly ParsedColorSwatch[];
  readonly families: readonly { readonly id: string; readonly value: string; readonly note: string }[];
  readonly scale: readonly { readonly id: string; readonly value: string }[];
  readonly styles: readonly ParsedTypeStyle[];
  readonly space: readonly { readonly id: string; readonly value: string }[];
  readonly radius: readonly { readonly id: string; readonly value: string }[];
  readonly css: string;
}

const safeCssIdent = (id: string) => id.trim().replace(/[^a-zA-Z0-9_-]/gu, "-");
const safeCssValue = (val: string) =>
  val
    .replace(/[{}<>\\]/gu, "")
    .replace(/;\s*/gu, " ")
    .trim();

function pickThemeValue(val: string | Record<string, string>, theme: string, fallbackTheme: string): string {
  if (typeof val === "string") return val;
  return val[theme] ?? val[fallbackTheme] ?? Object.values(val)[0] ?? "";
}

function resolveAliases(raw: string, map: ReadonlyMap<string, string>, seen = new Set<string>()): string {
  return raw.replace(/\{([a-zA-Z0-9_.-]+)\}/gu, (_full, ref: string) => {
    if (seen.has(ref)) return "";
    const target = map.get(ref);
    if (target === undefined) return `var(--${safeCssIdent(ref)})`;
    const next = new Set(seen);
    next.add(ref);
    return resolveAliases(target, map, next);
  });
}

export function parseTokensSpec(rawJson: string): ParsedTokensSpec {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    return {
      themes: ["light", "dark"],
      defaultTheme: "light",
      colors: [],
      families: [],
      scale: [],
      styles: [],
      space: [],
      radius: [],
      css: "",
    };
  }
  const parsed = TokensSpecSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      themes: ["light", "dark"],
      defaultTheme: "light",
      colors: [],
      families: [],
      scale: [],
      styles: [],
      space: [],
      radius: [],
      css: "",
    };
  }
  const spec = parsed.data;
  const themes = spec.themes && spec.themes.length > 0 ? spec.themes : ["light", "dark"];
  const defaultTheme = spec.defaultTheme ?? themes[0] ?? "light";

  const themeMaps = new Map<string, Map<string, string>>();
  const mapOf = (th: string): Map<string, string> => {
    let m = themeMaps.get(th);
    if (!m) {
      m = new Map();
      themeMaps.set(th, m);
    }
    return m;
  };
  for (const th of themes) mapOf(th);

  const addThemed = (prefix: string, items: readonly { id: string; value: string | Record<string, string> }[] | undefined) => {
    for (const item of items ?? []) {
      const key = `${prefix}-${safeCssIdent(item.id)}`;
      for (const th of themes) {
        const m = mapOf(th);
        const v = pickThemeValue(item.value, th, defaultTheme);
        m.set(item.id, v);
        m.set(key, v);
      }
    }
  };

  addThemed("color", spec.color);
  addThemed("space", spec.space);
  addThemed("radius", spec.radius);
  addThemed("shadow", spec.shadow);
  addThemed("border", spec.border);
  addThemed("motion", spec.motion);

  const families = (spec.type?.families ?? []).map((f) => ({
    id: safeCssIdent(f.id),
    value: safeCssValue(f.value),
    note: f.note ?? "",
  }));
  const scale = (spec.type?.scale ?? []).map((s) => ({
    id: safeCssIdent(s.id),
    value: safeCssValue(s.value),
  }));

  for (const th of themes) {
    const m = mapOf(th);
    for (const f of families) {
      m.set(f.id, f.value);
      m.set(`font-${f.id}`, f.value);
    }
    for (const s of scale) {
      m.set(s.id, s.value);
      m.set(`text-${s.id}`, s.value);
    }
  }

  const emitVarsForTheme = (th: string): string => {
    const m = mapOf(th);
    const decls: string[] = [];
    const pushCategory = (prefix: string, list: readonly { id: string; value: string | Record<string, string> }[] | undefined) => {
      for (const item of list ?? []) {
        const name = safeCssIdent(item.id);
        const raw = pickThemeValue(item.value, th, defaultTheme);
        const resolved = safeCssValue(resolveAliases(raw, m));
        decls.push(`--${prefix}-${name}:${resolved};`);
        // Also emit bare --<id> when unambiguous for ergonomic var(--surface) usage in slides/design.
        if (prefix === "color") decls.push(`--${name}:${resolved};`);
      }
    };
    pushCategory("color", spec.color);
    pushCategory("space", spec.space);
    pushCategory("radius", spec.radius);
    pushCategory("shadow", spec.shadow);
    pushCategory("border", spec.border);
    pushCategory("motion", spec.motion);
    for (const f of families) decls.push(`--font-${f.id}:${f.value};`);
    for (const s of scale) decls.push(`--text-${s.id}:${s.value};`);
    return decls.join("");
  };

  const cssBlocks: string[] = [];
  cssBlocks.push(`:root{${emitVarsForTheme(defaultTheme)}}`);
  for (const th of themes) {
    cssBlocks.push(`[data-theme="${safeCssIdent(th)}"]{color-scheme:${th === "dark" ? "dark" : "light"};${emitVarsForTheme(th)}}`);
  }

  const defaultMap = themeMaps.get(defaultTheme) ?? new Map<string, string>();
  const styles: ParsedTypeStyle[] = (spec.type?.styles ?? []).map((st) => {
    const id = safeCssIdent(st.id);
    const family = safeCssValue(resolveAliases(st.family, defaultMap));
    const size = safeCssValue(resolveAliases(st.size, defaultMap));
    const weight = safeCssValue(String(st.weight));
    const lineHeight = safeCssValue(String(st.lineHeight ?? 1.3));
    const letterSpacing = safeCssValue(st.letterSpacing ?? "0em");
    cssBlocks.push(`.type-${id}{font-family:${family};font-size:${size};font-weight:${weight};line-height:${lineHeight};letter-spacing:${letterSpacing};}`);
    return {
      id,
      family,
      size,
      weight,
      lineHeight,
      letterSpacing,
      sample: st.sample ?? "The quick brown fox jumps over the lazy dog 0123",
    };
  });

  const lightMap = themeMaps.get("light") ?? defaultMap;
  const darkMap = themeMaps.get("dark") ?? defaultMap;
  const colors: ParsedColorSwatch[] = (spec.color ?? []).map((c) => ({
    id: safeCssIdent(c.id),
    group: c.group ?? "core",
    light: safeCssValue(resolveAliases(pickThemeValue(c.value, "light", defaultTheme), lightMap)),
    dark: safeCssValue(resolveAliases(pickThemeValue(c.value, "dark", defaultTheme), darkMap)),
    note: c.note ?? "",
  }));

  const space = (spec.space ?? []).map((s) => ({
    id: safeCssIdent(s.id),
    value: safeCssValue(resolveAliases(pickThemeValue(s.value, defaultTheme, defaultTheme), defaultMap)),
  }));
  const radius = (spec.radius ?? []).map((r) => ({
    id: safeCssIdent(r.id),
    value: safeCssValue(resolveAliases(pickThemeValue(r.value, defaultTheme, defaultTheme), defaultMap)),
  }));

  return {
    themes,
    defaultTheme,
    colors,
    families,
    scale,
    styles,
    space,
    radius,
    css: cssBlocks.join("\n"),
  };
}

export function compileTokensCss(rawJson: string): string {
  return parseTokensSpec(rawJson).css;
}

function parseHexRgb(color: string): readonly [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color.trim());
  const hex = m?.[1];
  if (!hex) return undefined;
  if (hex.length === 3) {
    const r = hex.slice(0, 1);
    const g = hex.slice(1, 2);
    const b = hex.slice(2, 3);
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 2.1 contrast ratio (1..21) for hex colors, or undefined when either color is not a 3/6-digit hex color. */
export function contrastRatio(fg: string, bg: string): number | undefined {
  const a = parseHexRgb(fg);
  const b = parseHexRgb(bg);
  if (!a || !b) return undefined;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}
