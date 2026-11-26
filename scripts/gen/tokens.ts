import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");

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
    paper: z.record(z.string(), z.record(z.string(), HexColorSchema)),
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
    version: z.string().optional(),
    build: z.number().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    theme: z.string().optional(),
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

export function flattenPaperTheme(tokens: DesignTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [family, entries] of Object.entries(tokens.primitives.paper)) {
    for (const [key, value] of Object.entries(entries)) {
      if (key in out) throw new Error(`Duplicate paper token "${key}" in primitives.paper.${family}`);
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
      theme: flattenPaperTheme(tokens),
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
  const shadowRecord = Object.fromEntries(
    Object.entries(currentShadow).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "px"),
  );
  const { tailwind: _tailwind, ...rest } = manifest;

  const updated = {
    ...rest,
    tailwind: {
      fontSize: tokens.geometry.fontSize,
      radius: tokens.geometry.radius,
      ease: tokens.motion.ease,
      fontFamily: {
        sans: tokens.geometry.fontFamily.sans,
        mono: tokens.geometry.fontFamily.mono,
      },
      shadow: {
        ...shadowRecord,
        // nsh Tailwind shadow tokens require static #rrggbbaa colors rather than CSS variables.
        float: "0 8px 24px #0000002e",
        raise: "0 1px 2px #00000018",
        "toggle-thumb": shadowRecord["toggle-thumb"] ?? "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
      },
    },
  };
  return `${stringifyCompactArrays(updated)}\n`;
}

function cubicBezierCss(tuple: readonly [number, number, number, number]): string {
  return `cubic-bezier(${tuple.join(", ")})`;
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

export function generateTokenTargets(tokens: DesignTokens, rootDir = root): TargetOutput[] {
  const themeJsonPath = resolve(rootDir, "apps/mac/ui/design/theme.json");
  const nshJsonPath = resolve(rootDir, "apps/mac/ui/nsh.json");
  const themeTokensRsPath = resolve(rootDir, "apps/mac/src/theme_tokens.rs");
  const siteCssPath = resolve(rootDir, "apps/site/src/ui/global.css");
  const nshRaw = readFileSync(nshJsonPath, "utf8");
  const siteCssRaw = readFileSync(siteCssPath, "utf8");
  const themeContent = renderThemeJson(tokens);

  const targets: TargetOutput[] = [
    { path: themeJsonPath, content: themeContent },
    { path: nshJsonPath, content: renderNshJson(tokens, nshRaw) },
    { path: themeTokensRsPath, content: renderThemeTokensRs(tokens) },
    { path: siteCssPath, content: syncSiteGlobalCss(tokens, siteCssRaw) },
  ];

  const mobileNshJsonPath = resolve(rootDir, "apps/mobile/nsh.json");
  if (existsSync(mobileNshJsonPath)) {
    const mobileNshRaw = readFileSync(mobileNshJsonPath, "utf8");
    targets.push(
      { path: resolve(rootDir, "apps/mobile/design/theme.json"), content: themeContent },
      { path: mobileNshJsonPath, content: renderNshJson(tokens, mobileNshRaw) },
    );
  }
  return targets;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

export function runTokensGen(checkOnly: boolean, rootDir = root): string[] {
  const tokens = parseDesignTokens(readFileSync(resolve(rootDir, "design/tokens.json"), "utf8"));
  const targets = generateTokenTargets(tokens, rootDir);
  const drifted: string[] = [];
  for (const target of targets) {
    const existing = readOptional(target.path);
    if (existing !== target.content) {
      drifted.push(target.path);
      if (!checkOnly) {
        mkdirSync(dirname(target.path), { recursive: true });
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
