import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSync } from "vite";

const root = resolve(import.meta.dirname, "../..");
const uiRoot = resolve(root, "apps/mac/ui");

const SCAN_GLOBS = ["app/**/*.{ts,tsx}", "design/**/*.{ts,tsx}", "workspace/**/*.{ts,tsx}", "features/**/*.{ts,tsx}"] as const;
const EXCLUDE_GLOBS = [
  // Swatch palette & validation helper (defines swatches and hexColor).
  "design/domain/cast.ts",
  // Runtime token lookup & alpha blender (`tone`, `mix`).
  "design/tone.ts",
  // Pixel asset registry, sprite manifests, and procedural pixel renderers.
  "design/pixel/**",
  "**/*.test.*",
  "**/*.story.*",
  "**/*.stories.*",
  "**/fixtures/**",
  // GitHub Linguist external programming-language palette.
  "features/repo/repos.ts",
  // Serialized Excalidraw SVG export fills and isolated WebView stylesheet.
  "features/artifact/WhiteboardView.tsx",
  // ISO QR specification requires strict #ffffff / #000000 contrast regardless of theme.
  "design/Qr.tsx",
] as const;

const SWITCH_PRIMITIVE = "apps/mac/ui/design/layout.tsx";
const CHECKBOX_PRIMITIVE = "apps/mac/ui/design/Checkbox.tsx";

const HEX_LITERAL_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F-])/gu;
const RGB_CALL_RE = /\brgba?\s*\(/gu;
const TAILWIND_ARBITRARY_RE = /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via|rounded|shadow)-\[[^\]]+\]/gu;
const HEX_ALPHA_SUFFIX_RE = /^[0-9a-fA-F]{2}$/u;
const FULL_BORDER_TWO_RE = /\bborder-2\b/u;
const FULL_BORDER_ONE_RE = /(?:^|\s)border(?:\s|$)/u;
const FIXED_DOT_CLASS_RE = /\b(?:h-2\s+w-2|size-\d)/u;
const SELECTION_TEST_RE = /(?:selected|active|picked|current|focus|focused|\bon\b)/iu;

const BOX_GEOMETRY_STYLE_KEYS = new Set([
  "borderWidth",
  "borderLeftWidth",
  "borderRightWidth",
  "borderTopWidth",
  "borderBottomWidth",
  "padding",
  "paddingVertical",
  "paddingHorizontal",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
]);

export type ViolationRule = "hardcoded-color" | "arbitrary-tailwind" | "raw-control" | "selection-layout-shift";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: ViolationRule;
  readonly snippet: string;
  readonly fix: string;
}

const RULE_EXEMPTIONS: Readonly<Record<string, readonly ViolationRule[]>> = {
  // 5-state PKM task marker (TODO/DOING/DONE/WAIT/CANCELED), not binary <Checkbox>.
  "apps/mac/ui/features/pkm/OutlineEditor.tsx": ["raw-control"],
  // Third-party WeChat/Feishu/QQ brand stand-ins and QR quiet frame.
  "apps/mac/ui/features/connector/ConnectorsPage.tsx": ["hardcoded-color"],
  // Sandboxed WebView HTML CSS custom properties (--vv-*).
  "apps/mac/ui/features/artifact/shell.ts": ["hardcoded-color"],
};

interface AstNode {
  readonly type: string;
  readonly start?: number;
  readonly end?: number;
  readonly [key: string]: unknown;
}

const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const val = starts[mid] ?? 0;
    if (val <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function* walkAst(node: AstNode, ancestors: readonly AstNode[]): Generator<{ node: AstNode; ancestors: readonly AstNode[] }> {
  yield { node, ancestors };
  const nextAncestors = [...ancestors, node];
  for (const [key, val] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (isAstNode(item)) yield* walkAst(item, nextAncestors);
      }
    } else if (isAstNode(val)) {
      yield* walkAst(val, nextAncestors);
    }
  }
}

function isStringParsingHelper(ancestors: readonly AstNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (!a) continue;
    if (a.type === "NewExpression" && isAstNode(a.callee) && a.callee.type === "Identifier" && a.callee.name === "RegExp") return true;
    if (a.type === "CallExpression" && isAstNode(a.callee) && a.callee.type === "MemberExpression" && isAstNode(a.callee.property)) {
      const prop = a.callee.property.name;
      if (prop === "startsWith" || prop === "endsWith" || prop === "match" || prop === "replace" || prop === "replaceAll") return true;
    }
  }
  return false;
}

function exprLooksLikeColor(expr: AstNode, source: string): boolean {
  const start = typeof expr.start === "number" ? expr.start : 0;
  const end = typeof expr.end === "number" ? expr.end : 0;
  const slice = source.slice(start, end);
  return /color|Color|hex|tint|fill|stroke|bg|background/iu.test(slice);
}

function insideStyleOrJsxAttr(ancestors: readonly AstNode[]): boolean {
  return ancestors.some((a) => a.type === "JSXAttribute" || a.type === "JSXExpressionContainer");
}

function jsxAttrStringValue(attr: AstNode): string | undefined {
  const val = attr.value;
  if (!isAstNode(val)) return undefined;
  if (val.type === "Literal" && typeof val.value === "string") return val.value;
  if (val.type === "JSXExpressionContainer" && isAstNode(val.expression) && val.expression.type === "Literal" && typeof val.expression.value === "string") {
    return val.expression.value;
  }
  return undefined;
}

function jsxAttrName(attr: AstNode): string | undefined {
  return isAstNode(attr.name) && attr.name.type === "JSXIdentifier" && typeof attr.name.name === "string" ? attr.name.name : undefined;
}

function stringLiteralOf(node: unknown): string | undefined {
  return isAstNode(node) && node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function propertyKeyName(prop: AstNode): string | undefined {
  const key = prop.key;
  if (!isAstNode(key)) return undefined;
  if (key.type === "Identifier" && typeof key.name === "string") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

function isInteractiveJsxElement(el: AstNode | undefined): boolean {
  if (!el || !Array.isArray(el.attributes)) return false;
  for (const attr of el.attributes) {
    if (!isAstNode(attr) || attr.type !== "JSXAttribute") continue;
    const name = jsxAttrName(attr);
    if (name === "onPress" || name === "accessibilityState") return true;
    if (name === "role") {
      const role = jsxAttrStringValue(attr);
      if (role === "button" || role === "tab" || role === "radio" || role === "checkbox" || role === "option") return true;
    }
  }
  return false;
}

function staticClassTextOf(attr: AstNode): string {
  const val = attr.value;
  if (!isAstNode(val)) return "";
  if (val.type === "Literal" && typeof val.value === "string") return val.value;
  if (val.type === "JSXExpressionContainer" && isAstNode(val.expression) && val.expression.type === "TemplateLiteral" && Array.isArray(val.expression.quasis)) {
    return val.expression.quasis.filter(isAstNode).map(rawTemplateText).join(" ");
  }
  return "";
}

function boxBorderWidth(classNames: string): 0 | 1 | 2 {
  if (FULL_BORDER_TWO_RE.test(classNames)) return 2;
  if (FULL_BORDER_ONE_RE.test(classNames)) return 1;
  return 0;
}

function styleGeometryKeysOf(expr: unknown): Set<string> {
  const out = new Set<string>();
  if (!isAstNode(expr) || expr.type !== "ObjectExpression" || !Array.isArray(expr.properties)) return out;
  for (const prop of expr.properties) {
    if (!isAstNode(prop) || prop.type !== "Property") continue;
    const key = propertyKeyName(prop);
    if (key && BOX_GEOMETRY_STYLE_KEYS.has(key)) out.add(key);
  }
  return out;
}

function checkSelectionLayoutShift(out: Finding[], file: string, line: number, source: string, node: AstNode, ancestors: readonly AstNode[]): void {
  const attr = ancestors.findLast((a) => a.type === "JSXAttribute");
  if (!attr) return;
  const attrName = jsxAttrName(attr);
  const start = typeof node.start === "number" ? node.start : 0;
  const end = typeof node.end === "number" ? node.end : 0;
  const snippet = source.slice(start, end);

  if (attrName === "class") {
    const cons = stringLiteralOf(node.consequent);
    const alt = stringLiteralOf(node.alternate);
    if (cons === undefined || alt === undefined) return;
    if (cons.includes("border-dashed") || alt.includes("border-dashed")) return;
    if (FIXED_DOT_CLASS_RE.test(staticClassTextOf(attr))) return;

    const w1 = boxBorderWidth(cons);
    const w2 = boxBorderWidth(alt);
    if (w1 === w2) return;

    const testSlice = isAstNode(node.test)
      ? source.slice(typeof node.test.start === "number" ? node.test.start : 0, typeof node.test.end === "number" ? node.test.end : 0)
      : "";
    const jsxEl = ancestors.findLast((a) => a.type === "JSXOpeningElement");
    if ((w1 > 0 && w2 > 0) || isInteractiveJsxElement(jsxEl) || SELECTION_TEST_RE.test(testSlice)) {
      out.push({
        file,
        line,
        rule: "selection-layout-shift",
        snippet,
        fix: "keep border thickness constant across states (use `border-transparent` or a `pointer-events-none absolute inset-0` overlay)",
      });
    }
    return;
  }

  if (attrName === "style") {
    const parent = ancestors[ancestors.length - 1];
    if (parent && parent.type === "Property") {
      const key = propertyKeyName(parent);
      if (key && BOX_GEOMETRY_STYLE_KEYS.has(key)) {
        out.push({
          file,
          line,
          rule: "selection-layout-shift",
          snippet: `${key}: ${snippet}`,
          fix: "keep `borderWidth` and `padding` constant across states so selection never resizes the box",
        });
      }
      return;
    }

    const consKeys = styleGeometryKeysOf(node.consequent);
    const altKeys = styleGeometryKeysOf(node.alternate);
    const diffKeys = [...[...consKeys].filter((k) => !altKeys.has(k)), ...[...altKeys].filter((k) => !consKeys.has(k))];
    if (diffKeys.length > 0) {
      out.push({
        file,
        line,
        rule: "selection-layout-shift",
        snippet,
        fix: "keep `borderWidth` and `padding` constant across states (render active rings or strips via an absolute overlay)",
      });
    }
  }
}

function pushRegexMatches(out: Finding[], file: string, line: number, rule: ViolationRule, text: string, re: RegExp, fix: string): void {
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) {
    out.push({ file, line, rule, snippet: match[0], fix });
  }
}

function rawTemplateText(quasi: AstNode): string {
  const val = quasi.value;
  if (typeof val === "object" && val !== null && "raw" in val && typeof val.raw === "string") {
    return val.raw;
  }
  return "";
}

function scanStringValue(out: Finding[], file: string, line: number, text: string, checkColor: boolean): void {
  pushRegexMatches(
    out,
    file,
    line,
    "arbitrary-tailwind",
    text,
    TAILWIND_ARBITRARY_RE,
    "use canonical theme tokens from `design/tokens.json` (`apps/mac/ui/design/theme.json` / `nsh.json`)",
  );
  if (!checkColor) return;
  const masked = text.replace(TAILWIND_ARBITRARY_RE, (m) => " ".repeat(m.length));
  pushRegexMatches(
    out,
    file,
    line,
    "hardcoded-color",
    masked,
    HEX_LITERAL_RE,
    'use a semantic token class, `tone("...")`, or `mix("...", alpha)` from `design/tone.ts`',
  );
  pushRegexMatches(out, file, line, "hardcoded-color", masked, RGB_CALL_RE, 'use `mix("...", alpha)` from `design/tone.ts` instead of `rgb()` / `rgba()`');
}

export function isRuleExempt(file: string, rule: ViolationRule): boolean {
  const normalized = file.replaceAll("\\", "/");
  return RULE_EXEMPTIONS[normalized]?.includes(rule) ?? false;
}

export function scanUiTokens(relFile: string, source: string): Finding[] {
  const normalized = relFile.replaceAll("\\", "/");
  const lang = normalized.endsWith(".tsx") ? "tsx" : "ts";
  const parsed = parseSync(normalized, source, { lang });
  const program: unknown = parsed.program;
  if (!isAstNode(program)) throw new Error(`${normalized} parsed to no AST program`);

  const starts = lineStartsOf(source);
  const rawFindings: Finding[] = [];

  for (const { node, ancestors } of walkAst(program, [])) {
    const offset = typeof node.start === "number" ? node.start : 0;
    const line = lineAt(starts, offset);

    if (node.type === "Literal" && typeof node.value === "string" && !("regex" in node && node.regex !== undefined)) {
      scanStringValue(rawFindings, normalized, line, node.value, !isStringParsingHelper(ancestors));
      continue;
    }

    if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
      const expressions = Array.isArray(node.expressions) ? node.expressions.filter(isAstNode) : [];
      const inStyleOrJsx = insideStyleOrJsxAttr(ancestors);
      for (let i = 0; i < node.quasis.length; i++) {
        const q = node.quasis[i];
        if (!isAstNode(q)) continue;
        const value = rawTemplateText(q);
        const qOffset = typeof q.start === "number" ? q.start : offset;
        const qLine = lineAt(starts, qOffset);

        scanStringValue(rawFindings, normalized, qLine, value, !isStringParsingHelper(ancestors));

        if (i > 0 && HEX_ALPHA_SUFFIX_RE.test(value)) {
          const prevExpr = expressions[i - 1];
          if (prevExpr && (inStyleOrJsx || exprLooksLikeColor(prevExpr, source))) {
            const exprText = source.slice(typeof prevExpr.start === "number" ? prevExpr.start : 0, typeof prevExpr.end === "number" ? prevExpr.end : 0);
            rawFindings.push({
              file: normalized,
              line: qLine,
              rule: "hardcoded-color",
              snippet: `\${${exprText}}${value}`,
              fix: 'use `mix("...", alpha)` or a helper on `design/tone.ts` instead of hex-alpha string concatenation',
            });
          }
        }
      }
      continue;
    }

    if (node.type === "JSXOpeningElement" && isAstNode(node.name) && node.name.type === "JSXIdentifier" && node.name.name === "Switch") {
      if (normalized !== SWITCH_PRIMITIVE) {
        rawFindings.push({
          file: normalized,
          line,
          rule: "raw-control",
          snippet: "<Switch",
          fix: "use `Toggle` from `apps/mac/ui/design/layout.tsx` instead of raw `<Switch`",
        });
      }
      continue;
    }

    if (node.type === "ConditionalExpression") {
      checkSelectionLayoutShift(rawFindings, normalized, line, source, node, ancestors);
      continue;
    }

    if (
      node.type === "JSXAttribute" &&
      isAstNode(node.name) &&
      node.name.type === "JSXIdentifier" &&
      node.name.name === "role" &&
      jsxAttrStringValue(node) === "checkbox" &&
      normalized !== CHECKBOX_PRIMITIVE
    ) {
      rawFindings.push({
        file: normalized,
        line,
        rule: "raw-control",
        snippet: 'role="checkbox"',
        fix: 'use `Checkbox` from `apps/mac/ui/design/Checkbox.tsx` instead of custom `role="checkbox"`',
      });
    }
  }

  return rawFindings.filter((f) => !isRuleExempt(f.file, f.rule));
}

export function listWebUiFiles(): string[] {
  return globSync([...SCAN_GLOBS], {
    cwd: uiRoot,
    exclude: [...EXCLUDE_GLOBS],
  })
    .map((f) => `apps/mac/ui/${f.replaceAll("\\", "/")}`)
    .toSorted();
}

export function scanAllWebUi(): Finding[] {
  const out: Finding[] = [];
  for (const rel of listWebUiFiles()) {
    const src = readFileSync(resolve(root, rel), "utf8");
    out.push(...scanUiTokens(rel, src));
  }
  return out;
}

if (import.meta.main) {
  const listOnly = process.argv.includes("--list");
  const findings = scanAllWebUi();
  if (listOnly) {
    for (const f of findings) {
      console.log(`${f.file}:${f.line} [${f.rule}] ${f.snippet} — Fix: ${f.fix}`);
    }
    console.log(`\nTotal non-excluded findings: ${findings.length}`);
    process.exit(0);
  }
  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`${f.file}:${f.line} [${f.rule}] ${f.snippet}\n  Fix: ${f.fix}`);
    }
    console.error(`\nFound ${findings.length} design-token violation(s).`);
    process.exit(1);
  }
}
