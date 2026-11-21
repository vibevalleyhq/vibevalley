import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");
const tokensPath = resolve(root, "design/tokens.json");
const themeJsonPath = resolve(root, "apps/mac/ui/vv/theme.json");
const nshJsonPath = resolve(root, "apps/mac/ui/nsh.json");
const tokensTsPath = resolve(root, "apps/mac/ui/tokens.ts");
const motionTsPath = resolve(root, "apps/mac/ui/motion.ts");
const themeTokensRsPath = resolve(root, "apps/mac/src/theme_tokens.rs");
const siteCssPath = resolve(root, "apps/site/src/ui/global.css");

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{3,8}$/u);
const ColorValueSchema = z.string().min(1);

const SemanticModeSchema = z.object({
  rail: HexColorSchema,
  "on-rail": HexColorSchema,
  side: HexColorSchema,
  page: HexColorSchema,
  elevated: HexColorSchema,
  hover: HexColorSchema,
  selected: HexColorSchema,
  scrim: HexColorSchema,
  "code-bg": HexColorSchema,
  "code-ink": HexColorSchema,
  line: HexColorSchema,
  "line-strong": HexColorSchema,
  focus: HexColorSchema,
  ink: HexColorSchema,
  muted: HexColorSchema,
  faint: HexColorSchema,
  bark: HexColorSchema,
  accent: HexColorSchema,
  "accent-hover": HexColorSchema,
  leaf: HexColorSchema,
  wheat: HexColorSchema,
  berry: HexColorSchema,
  water: HexColorSchema,
  idle: HexColorSchema,
  "ok-soft": HexColorSchema,
  "ok-ink": HexColorSchema,
  "bad-soft": HexColorSchema,
  "warn-soft": HexColorSchema,
  "warn-ink": HexColorSchema,
  float: HexColorSchema,
  raise: HexColorSchema,
  shell: z.object({
    text: HexColorSchema,
    subtle: HexColorSchema,
    tile: HexColorSchema,
    border: HexColorSchema,
    "border-rgba": ColorValueSchema.optional(),
    "focus-ring": ColorValueSchema,
    warning: HexColorSchema,
    success: HexColorSchema,
    "code-num": HexColorSchema,
  }),
  terminal: z.object({
    foreground: HexColorSchema,
    background: HexColorSchema,
    cursor: HexColorSchema,
    selection: HexColorSchema,
    ansi: z.array(HexColorSchema).length(16),
  }),
  syntax: z.array(HexColorSchema).length(16),
});

const DesignTokensSchema = z.object({
  primitives: z.object({
    stone: z.record(z.string(), HexColorSchema),
    leaf: z.record(z.string(), HexColorSchema),
    wheat: z.record(z.string(), HexColorSchema),
    berry: z.record(z.string(), HexColorSchema),
    water: z.record(z.string(), HexColorSchema),
    violet: z.record(z.string(), HexColorSchema),
    teal: z.record(z.string(), HexColorSchema),
    pixel: z.record(z.string(), z.record(z.string(), HexColorSchema)),
  }),
  semantic: z.object({
    light: SemanticModeSchema,
    dark: SemanticModeSchema,
  }),
  geometry: z.object({
    radius: z.object({
      xs: z.number(),
      sm: z.number(),
      md: z.number(),
      lg: z.number(),
      xl: z.number(),
    }),
    controlHeight: z.object({
      compact: z.number(),
      control: z.number(),
      input: z.number(),
    }),
    fontFamily: z.object({
      sans: z.string(),
      mono: z.string(),
      pixel: z.string(),
      terminalMono: z.string(),
    }),
    fontSize: z.record(z.string(), z.tuple([z.number(), z.number()])),
  }),
  motion: z.object({
    duration: z.object({
      fast: z.number(),
      normal: z.number(),
      slow: z.number(),
    }),
    ease: z.object({
      out: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      in: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      "in-out": z.tuple([z.number(), z.number(), z.number(), z.number()]),
      spring: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  }),
});

export type DesignTokens = z.output<typeof DesignTokensSchema>;
type SemanticMode = z.output<typeof SemanticModeSchema>;

const NshManifestSchema = z
  .object({
    name: z.string(),
    id: z.string(),
    version: z.string(),
    build: z.number(),
    capabilities: z.record(z.string(), z.unknown()),
    theme: z.string(),
    tailwind: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const SEMANTIC_CSS_KEYS = [
  "page",
  "side",
  "elevated",
  "ink",
  "muted",
  "faint",
  "line",
  "line-strong",
  "hover",
  "selected",
  "focus",
  "accent",
  "accent-hover",
  "leaf",
  "wheat",
  "berry",
  "water",
  "bark",
  "ok-soft",
  "ok-ink",
  "bad-soft",
  "warn-soft",
  "warn-ink",
  "scrim",
  "rail",
  "on-rail",
  "idle",
  "code-bg",
  "code-ink",
  "float",
  "raise",
] as const;

export function parseDesignTokens(raw: string): DesignTokens {
  return DesignTokensSchema.parse(JSON.parse(raw));
}

export function flattenPixelTheme(tokens: DesignTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [family, entries] of Object.entries(tokens.primitives.pixel)) {
    for (const [key, value] of Object.entries(entries)) {
      if (key in out) throw new Error(`Duplicate pixel token "${key}" in primitives.pixel.${family}`);
      out[key] = value;
    }
  }
  return out;
}

function pickSemanticCssVars(mode: SemanticMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SEMANTIC_CSS_KEYS) {
    out[key] = mode[key];
  }
  return out;
}

export function renderThemeJson(tokens: DesignTokens): string {
  const doc = {
    cssVars: {
      theme: flattenPixelTheme(tokens),
      light: pickSemanticCssVars(tokens.semantic.light),
      dark: pickSemanticCssVars(tokens.semantic.dark),
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function stringifyCompactArrays(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const allPrimitives = value.every((v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean");
    if (allPrimitives) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (indent * 2 + inline.length <= 120) return inline;
    }
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    return `[\n${value.map((v) => `${pad}${stringifyCompactArrays(v, indent + 1)}`).join(",\n")}\n${closePad}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${stringifyCompactArrays(v, indent + 1)}`).join(",\n")}\n${closePad}}`;
  }
  return JSON.stringify(value);
}

export function renderNshJson(tokens: DesignTokens, currentRaw: string): string {
  const manifest = NshManifestSchema.parse(JSON.parse(currentRaw));
  const currentShadow = typeof manifest.tailwind?.shadow === "object" && manifest.tailwind.shadow !== null ? manifest.tailwind.shadow : {};
  const shadowRecord = Object.fromEntries(Object.entries(currentShadow).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

  const updated = {
    ...manifest,
    tailwind: {
      fontSize: tokens.geometry.fontSize,
      radius: tokens.geometry.radius,
      ease: tokens.motion.ease,
      fontFamily: {
        sans: tokens.geometry.fontFamily.sans,
        mono: tokens.geometry.fontFamily.mono,
        pixel: tokens.geometry.fontFamily.pixel,
      },
      shadow: {
        ...shadowRecord,
        // nsh Tailwind shadow tokens require static #rrggbbaa colors rather than CSS variables.
        float: "0 8px 24px #0000002e",
        raise: "0 1px 2px #00000018",
        "toggle-thumb": shadowRecord["toggle-thumb"] ?? "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
        px: shadowRecord.px ?? "2px 2px 0 #1e140a73",
      },
    },
  };
  return `${stringifyCompactArrays(updated)}\n`;
}

export function renderTokensTs(tokens: DesignTokens): string {
  const l = tokens.semantic.light;
  const d = tokens.semantic.dark;
  const r = tokens.geometry.radius;
  const smFont = tokens.geometry.fontSize.sm;
  const baseFont = tokens.geometry.fontSize.base;
  const xsFont = tokens.geometry.fontSize.xs;
  if (!smFont || !baseFont || !xsFont) {
    throw new Error("design/tokens.json geometry.fontSize must define xs, sm, and base");
  }
  const titleLine = Math.round(baseFont[0] * baseFont[1]);
  const bodyLine = Math.round(smFont[0] * smFont[1]);
  const darkBorder = d.shell["border-rgba"] ?? d.shell.border;

  return `// Generated from design/tokens.json by scripts/gen/tokens.ts — do not edit by hand.
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
  /** Primary button fill (accent in both light and dark modes). */
  primary: string;
  onPrimary: string;
  /** Sidebar and inspector background; mirrors theme.rs \`surface\` and workbench \`side\`. */
  canvas: string;
};

const light: Palette = {
  ink: "${l.ink}",
  text: "${l.shell.text}",
  muted: "${l.muted}",
  faint: "${l.faint}",
  surface: "${l.page}",
  subtle: "${l.shell.subtle}",
  tile: "${l.shell.tile}",
  border: "${l.shell.border}",
  focus: "${l.shell["focus-ring"]}",
  ok: "${l.leaf}",
  alert: "${l["warn-ink"]}",
  danger: "${l.berry}",
  codeKey: "${l.ink}",
  codeStr: "${l.syntax[15] ?? "#1f7a72"}",
  codeNum: "${l.shell["code-num"]}",
  codeLit: "${l.syntax[14] ?? "#7e42b8"}",
  primary: "${l.accent}",
  onPrimary: "${l.page}",
  canvas: "${l.side}",
};

const dark: Palette = {
  ink: "${d.ink}",
  text: "${d.shell.text}",
  muted: "${d.muted}",
  faint: "${d.faint}",
  surface: "${d.elevated}",
  subtle: "${d.shell.subtle}",
  tile: "${d.shell.tile}",
  border: "${darkBorder}",
  focus: "${d.shell["focus-ring"]}",
  ok: "${d.leaf}",
  alert: "${d.wheat}",
  danger: "${d.berry}",
  codeKey: "${d.ink}",
  codeStr: "${d.syntax[15] ?? "#5bbfb2"}",
  codeNum: "${d.shell["code-num"]}",
  codeLit: "${d.syntax[14] ?? "#c9a7eb"}",
  primary: "${d.accent}",
  onPrimary: "${d.page}",
  canvas: "${d.side}",
};

/** The palette of the scheme shown now (reactive). */
export function tok(): Palette {
  return colorScheme() === "dark" ? dark : light;
}

const fontMono = "${tokens.geometry.fontFamily.mono}";

export const type = {
  title: { fontSize: ${baseFont[0]}, lineHeight: ${titleLine} },
  body: { fontSize: ${smFont[0]}, lineHeight: ${bodyLine} },
  mono: { fontSize: ${xsFont[0]}, fontFamily: fontMono },
  label: { fontSize: ${xsFont[0]} },
  code: { fontSize: ${xsFont[0]}, lineHeight: 19, fontFamily: fontMono },
} as const;

export const radius = { sm: ${r.sm}, md: ${r.md}, lg: ${r.lg}, button: ${r.md}, card: ${r.lg}, tray: ${r.xl} } as const;

/** Card ring: an inset 1 px border ring plus a faint drop in light mode. */
export function cardShadow(p: Palette) {
  return p === dark
    ? [{ x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true }]
    : [
        { x: 0, y: 0, blur: 0, spread: 1, color: p.border, inset: true },
        { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(28,25,23,0.05)", inset: false },
      ];
}

/** Return a \`#rrggbb\` or \`rgba(...)\` token at \`alpha\` (0..1) opacity. */
export function tint(color: string, alpha: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return \`rgba(\${(n >> 16) & 255},\${(n >> 8) & 255},\${n & 255},\${alpha})\`;
  }
  return color.replace(/rgba\\(([^,]+),([^,]+),([^,]+),[^)]+\\)/u, \`rgba($1,$2,$3,\${alpha})\`);
}

/** \`danger\` at 6 % fill with a 16 % ring, for error boxes. */
export function dangerTint(p: Palette) {
  return { fill: tint(p.danger, 0.06), ring: tint(p.danger, 0.16) };
}
`;
}

function cubicBezierCss(tuple: readonly [number, number, number, number]): string {
  return `cubic-bezier(${tuple.join(", ")})`;
}

export function syncMotionTs(tokens: DesignTokens, currentRaw: string): string {
  const easeCss = cubicBezierCss(tokens.motion.ease.out);
  const replaced = currentRaw.replace(/^export const ease = "[^"]+";/mu, `export const ease = "${easeCss}";`);
  if (replaced === currentRaw && !currentRaw.includes(`export const ease = "${easeCss}";`)) {
    throw new Error("Could not locate `export const ease = ...` in apps/mac/ui/motion.ts");
  }
  return replaced;
}

export function syncSiteGlobalCss(tokens: DesignTokens, currentRaw: string): string {
  const easeCss = cubicBezierCss(tokens.motion.ease.out);
  const replaced = currentRaw.replace(/^(\s*--ease-out:\s*)[^;]+;/mu, `$1${easeCss};`);
  if (replaced === currentRaw && !currentRaw.includes(`--ease-out: ${easeCss};`)) {
    throw new Error("Could not locate `--ease-out` in apps/site/src/ui/global.css");
  }
  return replaced;
}

function rsHex(hex: string): string {
  const clean = hex.startsWith("#") ? hex.slice(1).toLowerCase() : hex.toLowerCase();
  if (clean.length !== 6) throw new Error(`Rust hex constants require 6-digit hex, got "${hex}"`);
  return `0x${clean}`;
}

function formatRsArray(name: string, values: readonly string[]): string {
  const items = values.map(rsHex).join(", ");
  const single = `const ${name}: [u32; ${values.length}] = [${items}];`;
  if (single.length <= 100) return single;
  const lines = values.map((v) => `    ${rsHex(v)},`).join("\n");
  return `const ${name}: [u32; ${values.length}] = [\n${lines}\n];`;
}

export function renderThemeTokensRs(tokens: DesignTokens): string {
  const d = tokens.semantic.dark;
  const l = tokens.semantic.light;
  const lines = [
    "// Generated from design/tokens.json by scripts/gen/tokens.ts — do not edit by hand.",
    "",
    `const DEFAULT_MONO_FONT: &str = "${tokens.geometry.fontFamily.terminalMono}";`,
    "",
    `const DARK_SURFACE: u32 = ${rsHex(d.side)};`,
    `const DARK_ELEVATED: u32 = ${rsHex(d.elevated)};`,
    `const DARK_BORDER: u32 = ${rsHex(d.shell.border)};`,
    `const DARK_MUTED: u32 = ${rsHex(d.muted)};`,
    `const DARK_FAINT: u32 = ${rsHex(d.faint)};`,
    `const DARK_ACCENT: u32 = ${rsHex(d.accent)};`,
    `const DARK_ON_ACCENT: u32 = ${rsHex(d.page)};`,
    `const DARK_HOVER_BASE: u32 = ${rsHex(d.ink)};`,
    `const DARK_DANGER: u32 = ${rsHex(d.berry)};`,
    `const DARK_WARNING: u32 = ${rsHex(d.shell.warning)};`,
    `const DARK_SUCCESS: u32 = ${rsHex(d.shell.success)};`,
    `const DARK_INFO: u32 = ${rsHex(d.water)};`,
    `const DARK_MATCH_BASE: u32 = ${rsHex(d.wheat)};`,
    "",
    `const TERM_DARK_FOREGROUND: u32 = ${rsHex(d.terminal.foreground)};`,
    `const TERM_DARK_BACKGROUND: u32 = ${rsHex(d.terminal.background)};`,
    `const TERM_DARK_CURSOR: u32 = ${rsHex(d.terminal.cursor)};`,
    `const TERM_DARK_SELECTION: u32 = ${rsHex(d.terminal.selection)};`,
    formatRsArray("TERM_DARK_ANSI", d.terminal.ansi),
    formatRsArray("SYNTAX_DARK", d.syntax),
    "",
    `const LIGHT_SURFACE: u32 = ${rsHex(l.side)};`,
    `const LIGHT_ELEVATED: u32 = ${rsHex(l.elevated)};`,
    `const LIGHT_BORDER: u32 = ${rsHex(l.shell.border)};`,
    `const LIGHT_MUTED: u32 = ${rsHex(l.muted)};`,
    `const LIGHT_FAINT: u32 = ${rsHex(l.faint)};`,
    `const LIGHT_ACCENT: u32 = ${rsHex(l.accent)};`,
    `const LIGHT_ON_ACCENT: u32 = ${rsHex(l.page)};`,
    `const LIGHT_HOVER_BASE: u32 = ${rsHex(l.ink)};`,
    `const LIGHT_DANGER: u32 = ${rsHex(l.berry)};`,
    `const LIGHT_WARNING: u32 = ${rsHex(l.shell.warning)};`,
    `const LIGHT_SUCCESS: u32 = ${rsHex(l.shell.success)};`,
    `const LIGHT_INFO: u32 = ${rsHex(l.water)};`,
    `const LIGHT_MATCH_BASE: u32 = ${rsHex(l.wheat)};`,
    "",
    `const TERM_LIGHT_FOREGROUND: u32 = ${rsHex(l.terminal.foreground)};`,
    `const TERM_LIGHT_BACKGROUND: u32 = ${rsHex(l.terminal.background)};`,
    `const TERM_LIGHT_CURSOR: u32 = ${rsHex(l.terminal.cursor)};`,
    `const TERM_LIGHT_SELECTION: u32 = ${rsHex(l.terminal.selection)};`,
    formatRsArray("TERM_LIGHT_ANSI", l.terminal.ansi),
    formatRsArray("SYNTAX_LIGHT", l.syntax),
    "",
  ];
  return lines.join("\n");
}

export interface TargetOutput {
  readonly path: string;
  readonly content: string;
}

export function generateTokenTargets(tokens: DesignTokens): TargetOutput[] {
  const nshRaw = readFileSync(nshJsonPath, "utf8");
  const motionRaw = readFileSync(motionTsPath, "utf8");
  const siteCssRaw = readFileSync(siteCssPath, "utf8");
  return [
    { path: themeJsonPath, content: renderThemeJson(tokens) },
    { path: nshJsonPath, content: renderNshJson(tokens, nshRaw) },
    { path: tokensTsPath, content: renderTokensTs(tokens) },
    { path: motionTsPath, content: syncMotionTs(tokens, motionRaw) },
    { path: themeTokensRsPath, content: renderThemeTokensRs(tokens) },
    { path: siteCssPath, content: syncSiteGlobalCss(tokens, siteCssRaw) },
  ];
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

export function runTokensGen(checkOnly: boolean): string[] {
  const tokens = parseDesignTokens(readFileSync(tokensPath, "utf8"));
  const targets = generateTokenTargets(tokens);
  const drifted: string[] = [];
  for (const target of targets) {
    const existing = readOptional(target.path);
    if (existing !== target.content) {
      drifted.push(target.path);
      if (!checkOnly) {
        writeFileSync(target.path, target.content, "utf8");
      }
    }
  }
  return drifted;
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const drifted = runTokensGen(checkOnly);
  if (checkOnly && drifted.length > 0) {
    console.error(`Design token targets are out of sync with design/tokens.json (${drifted.length} drifted):`);
    for (const file of drifted) console.error(`  - ${file}`);
    console.error("Fix: vpx scripts/gen/tokens.ts");
    process.exit(1);
  }
}
