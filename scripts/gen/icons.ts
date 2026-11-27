import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

export const EXPECTED_ICON_COUNT = 98;

export type VectorLineCap = "butt" | "round" | "square";
export type VectorLineJoin = "miter" | "round" | "bevel";

export interface VectorIconShape {
  readonly d: string;
  readonly fill: boolean;
  readonly stroke?: number;
  readonly cap?: VectorLineCap;
  readonly join?: VectorLineJoin;
  readonly evenodd?: boolean;
  readonly opacity?: number;
}

export interface ParsedIconEntry {
  readonly name: string;
  readonly shapes: readonly VectorIconShape[];
}

export interface IconTargetOutput {
  readonly path: string;
  readonly content: string;
}

type Token =
  | { readonly kind: "ident"; readonly value: string; readonly pos: number }
  | { readonly kind: "string"; readonly value: string; readonly pos: number }
  | { readonly kind: "number"; readonly value: number; readonly pos: number }
  | { readonly kind: "punct"; readonly value: string; readonly pos: number };

function decodeRustString(source: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let out = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') return { value: out, next: i + 1 };
    if (ch === "\\") {
      i++;
      const esc = source[i];
      if (esc === undefined) throw new Error(`Unterminated string escape at offset ${start}`);
      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "0") out += "\0";
      else if (esc === "\\" || esc === '"' || esc === "'") out += esc;
      else if (esc === "\n") {
        while (i + 1 < source.length && /[ \t\r\n]/u.test(source[i + 1] ?? "")) i++;
      } else if (esc === "x") {
        const hex = source.slice(i + 1, i + 3);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
      } else if (esc === "u" && source[i + 1] === "{") {
        const close = source.indexOf("}", i + 2);
        if (close === -1) throw new Error(`Unterminated unicode escape at offset ${i}`);
        out += String.fromCodePoint(Number.parseInt(source.slice(i + 2, close).replaceAll("_", ""), 16));
        i = close;
      } else {
        out += esc;
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  throw new Error(`Unterminated Rust string literal at offset ${start}`);
}

function decodeRustRawString(source: string, start: number): { value: string; next: number } | undefined {
  if (source[start] !== "r") return undefined;
  let hashes = 0;
  let i = start + 1;
  while (source[i] === "#") {
    hashes++;
    i++;
  }
  if (source[i] !== '"') return undefined;
  const contentStart = i + 1;
  const endMarker = `"${"#".repeat(hashes)}`;
  const close = source.indexOf(endMarker, contentStart);
  if (close === -1) throw new Error(`Unterminated Rust raw string literal at offset ${start}`);
  return { value: source.slice(contentStart, close), next: close + endMarker.length };
}

function tokenizeRust(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === '"') {
      const decoded = decodeRustString(source, i);
      tokens.push({ kind: "string", value: decoded.value, pos: i });
      i = decoded.next;
      continue;
    }
    const raw = decodeRustRawString(source, i);
    if (raw) {
      tokens.push({ kind: "string", value: raw.value, pos: i });
      i = raw.next;
      continue;
    }
    if (ch === "'") {
      // Skip Rust char literals like `'a'` or `'\''`; lifetimes like `'static` fall through as `'` + ident.
      if (source[i + 1] === "\\" && source[i + 2] !== undefined && source[i + 3] === "'") {
        tokens.push({ kind: "punct", value: "'", pos: i });
        i += 4;
        continue;
      }
      if (source[i + 1] !== undefined && source[i + 1] !== "'" && source[i + 2] === "'") {
        tokens.push({ kind: "punct", value: "'", pos: i });
        i += 3;
        continue;
      }
      tokens.push({ kind: "punct", value: "'", pos: i });
      i++;
      continue;
    }
    if ((ch === "-" && /\d/u.test(source[i + 1] ?? "")) || /\d/u.test(ch)) {
      const start = i;
      if (ch === "-") i++;
      while (i < source.length && /[\d_]/u.test(source[i] ?? "")) i++;
      if (source[i] === "." && /\d/u.test(source[i + 1] ?? "")) {
        i++;
        while (i < source.length && /[\d_]/u.test(source[i] ?? "")) i++;
      }
      const numText = source.slice(start, i).replaceAll("_", "");
      while (i < source.length && /[A-Za-z0-9_]/u.test(source[i] ?? "")) i++;
      const parsed = Number(numText);
      if (!Number.isFinite(parsed)) throw new Error(`Invalid number literal "${numText}" at offset ${start}`);
      tokens.push({ kind: "number", value: parsed, pos: start });
      continue;
    }
    if (/[A-Za-z_]/u.test(ch)) {
      const start = i;
      i++;
      while (i < source.length && /[A-Za-z0-9_]/u.test(source[i] ?? "")) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), pos: start });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "::" || two === "=>") {
      tokens.push({ kind: "punct", value: two, pos: i });
      i += 2;
      continue;
    }
    tokens.push({ kind: "punct", value: ch, pos: i });
    i++;
  }
  return tokens;
}

class TokenCursor {
  index = 0;
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  next(): Token {
    const token = this.tokens[this.index++];
    if (!token) throw new Error("Unexpected end of Rust icon source");
    return token;
  }

  isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punct" && token.value === value;
  }

  isIdent(value: string): boolean {
    const token = this.peek();
    return token?.kind === "ident" && token.value === value;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) {
      throw new Error(`Expected "${value}" at offset ${token.pos}, got ${token.kind}("${String(token.value)}")`);
    }
  }

  expectIdent(expected?: string): string {
    const token = this.next();
    if (token.kind !== "ident") {
      throw new Error(`Expected identifier at offset ${token.pos}, got ${token.kind}("${String(token.value)}")`);
    }
    if (expected !== undefined && token.value !== expected) {
      throw new Error(`Expected identifier "${expected}" at offset ${token.pos}, got "${token.value}"`);
    }
    return token.value;
  }

  expectString(): string {
    const token = this.next();
    if (token.kind !== "string") {
      throw new Error(`Expected string literal at offset ${token.pos}, got ${token.kind}("${String(token.value)}")`);
    }
    return token.value;
  }

  expectNumber(): number {
    const token = this.next();
    if (token.kind !== "number") {
      throw new Error(`Expected number literal at offset ${token.pos}, got ${token.kind}("${token.value}")`);
    }
    return token.value;
  }

  expectBool(): boolean {
    const word = this.expectIdent();
    if (word === "true") return true;
    if (word === "false") return false;
    throw new Error(`Expected boolean literal ("true" | "false"), got "${word}"`);
  }

  seekConst(name: string): boolean {
    for (let i = 0; i + 1 < this.tokens.length; i++) {
      const a = this.tokens[i];
      const b = this.tokens[i + 1];
      if (a?.kind === "ident" && a.value === "const" && b?.kind === "ident" && b.value === name) {
        this.index = i + 2;
        return true;
      }
    }
    return false;
  }

  seekFn(name: string): boolean {
    for (let i = 0; i + 1 < this.tokens.length; i++) {
      const a = this.tokens[i];
      const b = this.tokens[i + 1];
      if (a?.kind === "ident" && a.value === "fn" && b?.kind === "ident" && b.value === name) {
        this.index = i + 2;
        return true;
      }
    }
    return false;
  }
}

function parseOptionNumber(cursor: TokenCursor): number | undefined {
  const variant = cursor.expectIdent();
  if (variant === "None") return undefined;
  if (variant === "Some") {
    cursor.expectPunct("(");
    const value = cursor.expectNumber();
    cursor.expectPunct(")");
    return value;
  }
  throw new Error(`Expected Option<f32> ("None" | "Some(...)"), got "${variant}"`);
}

function parseLineCap(cursor: TokenCursor): VectorLineCap {
  cursor.expectIdent("LineCap");
  cursor.expectPunct("::");
  const variant = cursor.expectIdent();
  if (variant === "Butt") return "butt";
  if (variant === "Round") return "round";
  if (variant === "Square") return "square";
  throw new Error(`Unsupported LineCap variant: LineCap::${variant}`);
}

function parseLineJoin(cursor: TokenCursor): VectorLineJoin {
  cursor.expectIdent("LineJoin");
  cursor.expectPunct("::");
  const variant = cursor.expectIdent();
  if (variant === "Miter") return "miter";
  if (variant === "Round") return "round";
  if (variant === "Bevel") return "bevel";
  throw new Error(`Unsupported LineJoin variant: LineJoin::${variant}`);
}

function normalizeShape(raw: {
  d: string;
  fill: boolean;
  stroke: number | undefined;
  cap: VectorLineCap;
  join: VectorLineJoin;
  evenodd: boolean;
  opacity: number | undefined;
}): VectorIconShape {
  const out: {
    d: string;
    fill: boolean;
    stroke?: number;
    cap?: VectorLineCap;
    join?: VectorLineJoin;
    evenodd?: boolean;
    opacity?: number;
  } = { d: raw.d, fill: raw.fill };
  if (raw.stroke !== undefined) out.stroke = raw.stroke;
  if (raw.cap !== "butt") out.cap = raw.cap;
  if (raw.join !== "miter") out.join = raw.join;
  if (raw.evenodd) out.evenodd = true;
  if (raw.opacity !== undefined) out.opacity = raw.opacity;
  return out;
}

function parseIconShape(cursor: TokenCursor): VectorIconShape {
  cursor.expectIdent("IconShape");
  if (cursor.isPunct("::")) {
    cursor.expectPunct("::");
    const ctor = cursor.expectIdent();
    cursor.expectPunct("(");
    if (ctor === "filled") {
      const d = cursor.expectString();
      if (cursor.isPunct(",")) cursor.next();
      cursor.expectPunct(")");
      return { d, fill: true };
    }
    if (ctor === "filled_evenodd") {
      const d = cursor.expectString();
      if (cursor.isPunct(",")) cursor.next();
      cursor.expectPunct(")");
      return { d, fill: true, evenodd: true };
    }
    if (ctor === "stroked_round") {
      const d = cursor.expectString();
      cursor.expectPunct(",");
      const stroke = cursor.expectNumber();
      if (cursor.isPunct(",")) cursor.next();
      cursor.expectPunct(")");
      return { d, fill: false, stroke, cap: "round", join: "round" };
    }
    throw new Error(`Unsupported IconShape constructor: IconShape::${ctor}`);
  }
  cursor.expectPunct("{");
  let d: string | undefined;
  let fill: boolean | undefined;
  let stroke: number | undefined;
  let hasStroke = false;
  let cap: VectorLineCap | undefined;
  let join: VectorLineJoin | undefined;
  let evenodd: boolean | undefined;
  let opacity: number | undefined;
  let hasOpacity = false;

  while (!cursor.isPunct("}")) {
    const field = cursor.expectIdent();
    cursor.expectPunct(":");
    switch (field) {
      case "d":
        d = cursor.expectString();
        break;
      case "fill":
        fill = cursor.expectBool();
        break;
      case "stroke":
        stroke = parseOptionNumber(cursor);
        hasStroke = true;
        break;
      case "cap":
        cap = parseLineCap(cursor);
        break;
      case "join":
        join = parseLineJoin(cursor);
        break;
      case "evenodd":
        evenodd = cursor.expectBool();
        break;
      case "opacity":
        opacity = parseOptionNumber(cursor);
        hasOpacity = true;
        break;
      default:
        throw new Error(`Unknown IconShape field "${field}"`);
    }
    if (cursor.isPunct(",")) cursor.next();
  }
  cursor.expectPunct("}");

  if (d === undefined || fill === undefined || !hasStroke || cap === undefined || join === undefined || evenodd === undefined || !hasOpacity) {
    throw new Error("Incomplete IconShape struct literal: all 7 fields (d, fill, stroke, cap, join, evenodd, opacity) are required");
  }
  return normalizeShape({ d, fill, stroke, cap, join, evenodd, opacity });
}

function advancePastEquals(cursor: TokenCursor, label: string): void {
  while (cursor.peek()) {
    if (cursor.isPunct("=")) {
      cursor.next();
      return;
    }
    cursor.next();
  }
  throw new Error(`Could not locate "=" for ${label}`);
}

export function parseRustIcons(rustSource: string): ParsedIconEntry[] {
  const tokens = tokenizeRust(rustSource);
  const cursor = new TokenCursor(tokens);

  if (!cursor.seekConst("ICON_NAMES")) {
    throw new Error("Could not locate `const ICON_NAMES` in crates/rich/src/icon.rs");
  }
  advancePastEquals(cursor, "ICON_NAMES");
  cursor.expectPunct("&");
  cursor.expectPunct("[");
  const names: string[] = [];
  const seenNames = new Set<string>();
  while (!cursor.isPunct("]")) {
    const name = cursor.expectString();
    if (seenNames.has(name)) throw new Error(`Duplicate icon name "${name}" in ICON_NAMES`);
    seenNames.add(name);
    names.push(name);
    if (cursor.isPunct(",")) cursor.next();
  }
  cursor.expectPunct("]");

  if (!cursor.seekConst("ICON_SHAPES")) {
    throw new Error("Could not locate `const ICON_SHAPES` in crates/rich/src/icon.rs");
  }
  advancePastEquals(cursor, "ICON_SHAPES");
  cursor.expectPunct("[");
  const shapeGroups: VectorIconShape[][] = [];
  while (!cursor.isPunct("]")) {
    cursor.expectPunct("&");
    cursor.expectPunct("[");
    const group: VectorIconShape[] = [];
    while (!cursor.isPunct("]")) {
      group.push(parseIconShape(cursor));
      if (cursor.isPunct(",")) cursor.next();
    }
    cursor.expectPunct("]");
    shapeGroups.push(group);
    if (cursor.isPunct(",")) cursor.next();
  }
  cursor.expectPunct("]");

  if (names.length !== shapeGroups.length) {
    throw new Error(`ICON_NAMES (${names.length}) and ICON_SHAPES (${shapeGroups.length}) length mismatch`);
  }

  // If `fn icon_index` is present, verify every match arm aligns with ICON_NAMES indices.
  if (cursor.seekFn("icon_index")) {
    while (cursor.peek() && !cursor.isIdent("match")) cursor.next();
    if (cursor.isIdent("match")) {
      while (cursor.peek() && !cursor.isPunct("{")) cursor.next();
      cursor.expectPunct("{");
      const indexed = new Map<string, number>();
      while (!cursor.isPunct("}")) {
        const token = cursor.peek();
        if (token?.kind === "string") {
          const armName = cursor.expectString();
          cursor.expectPunct("=>");
          cursor.expectIdent("Some");
          cursor.expectPunct("(");
          const armIndex = cursor.expectNumber();
          cursor.expectPunct(")");
          indexed.set(armName, armIndex);
        } else {
          while (cursor.peek() && !cursor.isPunct(",") && !cursor.isPunct("}")) cursor.next();
        }
        if (cursor.isPunct(",")) cursor.next();
      }
      if (indexed.size !== names.length) {
        throw new Error(`icon_index match arms (${indexed.size}) do not match ICON_NAMES (${names.length})`);
      }
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (name === undefined || indexed.get(name) !== i) {
          throw new Error(`icon_index mismatch for "${String(name)}": expected Some(${i}), got ${String(indexed.get(name ?? ""))}`);
        }
      }
    }
  }

  return names.map((name, idx) => {
    const shapes = shapeGroups[idx] ?? [];
    if (shapes.length === 0) throw new Error(`Icon "${name}" has no vector shapes`);
    for (let s = 0; s < shapes.length; s++) {
      const shape = shapes[s];
      if (!shape || shape.d.trim().length === 0) {
        throw new Error(`Icon "${name}" shape ${s} has empty SVG path data`);
      }
      const hasStroke = shape.stroke !== undefined && shape.stroke > 0;
      if (!shape.fill && !hasStroke) {
        throw new Error(`Icon "${name}" shape ${s} neither fills nor strokes`);
      }
    }
    return { name, shapes };
  });
}

export function parseTsIconNames(tsSource: string): string[] {
  const match = /export\s+type\s+IconName\s*=([\s\S]*?);/u.exec(tsSource);
  if (!match?.[1]) {
    throw new Error("Could not locate `export type IconName = ...;`");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of match[1].matchAll(/"([^"]+)"/gu)) {
    const name = item[1];
    if (name === undefined) continue;
    if (seen.has(name)) throw new Error(`Duplicate IconName "${name}" in TypeScript union`);
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function assertIconNameParity(rustNames: readonly string[], tsNames: readonly string[], tsLabel: string): void {
  const rustSet = new Set(rustNames);
  const tsSet = new Set(tsNames);
  const missingInTs = rustNames.filter((n) => !tsSet.has(n));
  const extraInTs = tsNames.filter((n) => !rustSet.has(n));
  if (missingInTs.length > 0 || extraInTs.length > 0) {
    const details: string[] = [];
    if (missingInTs.length > 0) details.push(`missing in ${tsLabel}: ${missingInTs.join(", ")}`);
    if (extraInTs.length > 0) details.push(`extra in ${tsLabel}: ${extraInTs.join(", ")}`);
    throw new Error(`IconName parity mismatch between crates/rich/src/icon.rs and ${tsLabel} (${details.join("; ")})`);
  }
}

function formatKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
}

function formatShape(shape: VectorIconShape): string {
  const parts = [`d: ${JSON.stringify(shape.d)}`, `fill: ${String(shape.fill)}`];
  if (shape.stroke !== undefined) parts.push(`stroke: ${String(shape.stroke)}`);
  if (shape.cap !== undefined) parts.push(`cap: ${JSON.stringify(shape.cap)}`);
  if (shape.join !== undefined) parts.push(`join: ${JSON.stringify(shape.join)}`);
  if (shape.evenodd === true) parts.push("evenodd: true");
  if (shape.opacity !== undefined) parts.push(`opacity: ${String(shape.opacity)}`);
  return `{ ${parts.join(", ")} }`;
}

export function renderIconPathsTs(entries: readonly ParsedIconEntry[]): string {
  const lines: string[] = [
    "// Generated by scripts/gen/icons.ts from crates/rich/src/icon.rs — do not edit by hand.",
    'import type { IconName } from "./icons";',
    "",
    "export interface VectorIconShape {",
    "  readonly d: string;",
    "  readonly fill: boolean;",
    "  readonly stroke?: number;",
    '  readonly cap?: "butt" | "round" | "square";',
    '  readonly join?: "miter" | "round" | "bevel";',
    "  readonly evenodd?: boolean;",
    "  readonly opacity?: number;",
    "}",
    "",
    "export const ICON_PATHS: Record<IconName, readonly VectorIconShape[]> = {",
  ];
  for (const entry of entries) {
    lines.push(`  ${formatKey(entry.name)}: [`);
    for (const shape of entry.shapes) {
      lines.push(`    ${formatShape(shape)},`);
    }
    lines.push("  ],");
  }
  lines.push(
    "};",
    "",
    "export interface VectorIconCanvas<P> {",
    "  globalAlpha: unknown;",
    "  fillStyle: unknown;",
    "  strokeStyle: unknown;",
    "  lineWidth: unknown;",
    '  lineCap: "butt" | "round" | "square";',
    '  lineJoin: "miter" | "round" | "bevel";',
    "  save(): void;",
    "  restore(): void;",
    "  scale(x: number, y: number): void;",
    '  fill(path: P, fillRule?: "nonzero" | "evenodd"): void;',
    "  stroke(path: P): void;",
    "}",
    "",
    "export function createIconPathCache<P>(buildPath: (d: string) => P): (d: string) => P {",
    "  const cache = new Map<string, P>();",
    "  return (d: string) => {",
    "    let path = cache.get(d);",
    "    if (path === undefined) {",
    "      path = buildPath(d);",
    "      cache.set(d, path);",
    "    }",
    "    return path;",
    "  };",
    "}",
    "",
    "export function drawIconShapes<P>(",
    "  cx: VectorIconCanvas<NoInfer<P>>,",
    "  shapes: readonly VectorIconShape[],",
    "  size: number,",
    "  color: string,",
    "  getPath: (d: string) => P,",
    "): void {",
    "  if (!Number.isFinite(size) || size <= 0) return;",
    "  cx.save();",
    "  cx.scale(size / 24, size / 24);",
    "  for (const shape of shapes) {",
    "    cx.globalAlpha = shape.opacity ?? 1;",
    "    const path = getPath(shape.d);",
    "    if (shape.fill) {",
    "      cx.fillStyle = color;",
    '      if (shape.evenodd === true) cx.fill(path, "evenodd");',
    "      else cx.fill(path);",
    "    }",
    "    if (shape.stroke !== undefined && shape.stroke > 0) {",
    "      cx.strokeStyle = color;",
    "      cx.lineWidth = shape.stroke;",
    '      cx.lineCap = shape.cap ?? "butt";',
    '      cx.lineJoin = shape.join ?? "miter";',
    "      cx.stroke(path);",
    "    }",
    "  }",
    "  cx.restore();",
    "}",
    "",
  );
  return lines.join("\n");
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

export function generateIconTargets(rootDir = root): IconTargetOutput[] {
  const rustPath = resolve(rootDir, "crates/rich/src/icon.rs");
  const macIcons = resolve(rootDir, "apps/mac/ui/design/icons.ts");
  const entries = parseRustIcons(readFileSync(rustPath, "utf8"));
  if (entries.length !== EXPECTED_ICON_COUNT) {
    throw new Error(`Expected ${EXPECTED_ICON_COUNT} icons in crates/rich/src/icon.rs, found ${entries.length}`);
  }
  const rustNames = entries.map((e) => e.name);
  assertIconNameParity(rustNames, parseTsIconNames(readFileSync(macIcons, "utf8")), "apps/mac/ui/design/icons.ts");

  const content = renderIconPathsTs(entries);
  const targets: IconTargetOutput[] = [{ path: resolve(rootDir, "apps/mac/ui/design/iconPaths.gen.ts"), content }];

  const mobileDesignDir = resolve(rootDir, "apps/mobile/design");
  if (existsSync(mobileDesignDir)) {
    const mobileIcons = resolve(mobileDesignDir, "icons.ts");
    if (existsSync(mobileIcons)) {
      assertIconNameParity(rustNames, parseTsIconNames(readFileSync(mobileIcons, "utf8")), "apps/mobile/design/icons.ts");
    }
    targets.push({ path: resolve(mobileDesignDir, "iconPaths.gen.ts"), content });
  }
  return targets;
}

export function runIconsGen(checkOnly: boolean, rootDir = root): string[] {
  const targets = generateIconTargets(rootDir);
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
  const drifted = runIconsGen(checkOnly);
  if (checkOnly && drifted.length > 0) {
    console.error(`Generated icon path modules are out of sync with crates/rich/src/icon.rs (${drifted.length} drifted):`);
    for (const file of drifted) console.error(`  - ${file}`);
    console.error("Fix: vpx scripts/gen/icons.ts");
    process.exit(1);
  }
}
