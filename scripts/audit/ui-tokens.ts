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
  "**/*.test.*",
  "**/*.story.*",
  "**/*.stories.*",
  "**/fixtures/**",
  // GitHub Linguist external programming-language palette.
  "features/repo/repos.ts",
  // Serialized Excalidraw SVG export fills and isolated WebView stylesheet.
  "features/note/WhiteboardView.tsx",
  // ISO QR specification requires strict #ffffff / #000000 contrast regardless of theme.
  "design/Qr.tsx",
] as const;

const SWITCH_PRIMITIVE = "apps/mac/ui/design/layout.tsx";
const CHECKBOX_PRIMITIVE = "apps/mac/ui/design/Checkbox.tsx";
const MOTION_PRIMITIVE = "apps/mac/ui/design/motion.ts";

const HEX_LITERAL_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F-])/gu;
const RGB_CALL_RE = /\brgba?\s*\(/gu;
const TAILWIND_ARBITRARY_RE = /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via|rounded|shadow)-\[[^\]]+\]/gu;
const COLOR_TRANSITION_CLASS_RE = /(?:^|\s)(transition(?:-(?:colors|all))?)(?=\s|$)/gu;
const COLOR_TRANSITION_TIMED_RE = /(?:^|\s)(transition-(?:colors|all)|transition\s+(?:duration-|ease-|delay-)\S*)(?=\s|$)/gu;
const COLOR_TRANSITION_PROP_RE = /\b(?:colors|all)\b/u;
const MANAGED_MOTION_CLASS_RE = /(?:^|\s)(transition-(?:transform|opacity|shadow)|animate-(?:pulse|spin|bounce|ping))(?=\s|$)/gu;
const POPUP_TRANSITION_ATTRS = new Set(["startingClass", "endingClass", "popupStartingClass", "popupEndingClass"]);
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

export type ViolationRule =
  | "hardcoded-color"
  | "arbitrary-tailwind"
  | "raw-control"
  | "selection-layout-shift"
  | "color-transition"
  | "unmanaged-motion"
  | "glyph-icon-substitute";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: ViolationRule;
  readonly snippet: string;
  readonly fix: string;
}

const RULE_EXEMPTIONS: Readonly<Record<string, readonly ViolationRule[]>> = {
  // Runtime emblem fallback palette.
  "apps/mac/ui/design/domain/RuntimeIcon.tsx": ["hardcoded-color"],
  // Third-party WeChat/Feishu/QQ brand stand-ins and QR quiet frame.
  "apps/mac/ui/features/connector/ConnectorsPage.tsx": ["hardcoded-color"],
  // Sandboxed WebView HTML CSS custom properties (--vv-*).
  "apps/mac/ui/features/note/shell.ts": ["hardcoded-color"],
  // Pure whiteboard SVG illustrations, canvas themes, and WebView runtime stylesheet.
  "apps/mac/ui/features/note/whiteboard.ts": ["hardcoded-color"],
  // Starter note HTML/design JSON seed templates authored for user sandboxes.
  "apps/mac/ui/features/content/appSeeds.ts": ["hardcoded-color"],
  "apps/mac/ui/features/content/templateSeeds.ts": ["hardcoded-color"],
  "apps/mac/ui/features/content/visualSeeds.ts": ["hardcoded-color"],
  // Emoji grid and keyboard shortcut labels legitimately render character glyphs.
  "apps/mac/ui/features/channel/views/EmojiPicker.tsx": ["glyph-icon-substitute"],
  "apps/mac/ui/infra/base/shortcuts.ts": ["glyph-icon-substitute"],
};

const GLYPH_ICON_EXEMPT_PREFIXES = ["apps/mac/ui/farm/games/"] as const;
const GLYPH_ICON_HOST_TAGS = new Set(["Text", "Button", "ButtonLink"]);
const GLYPH_ICON_EXEMPT_ANCESTORS = new Set(["Kbd", "KeyCap"]);
const STANDALONE_GLYPH_ICONS = new Set(["×", "✕", "✖", "✓", "✔", "▸", "▾", "▲", "▼", "←", "→", "＋", "[x]", "[ ]"]);
const GLYPH_ICON_FIX = 'use `<Icon name="..." />` from `apps/mac/ui/design/Icon.tsx` instead of a text glyph icon';

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

function insideClassAttr(ancestors: readonly AstNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a?.type === "JSXAttribute") {
      const name = jsxAttrName(a);
      return name === "class" || (name !== undefined && name.endsWith("Class"));
    }
  }
  return false;
}

function insideMotionCall(ancestors: readonly AstNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a?.type === "CallExpression" && isAstNode(a.callee) && a.callee.type === "Identifier") {
      return a.callee.name === "motionClass" || a.callee.name === "popupTransition";
    }
    if (a?.type === "JSXAttribute") return false;
  }
  return false;
}

function insideMotionOffGuard(ancestors: readonly AstNode[], source: string): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a?.type === "ConditionalExpression" && isAstNode(a.test)) {
      const start = typeof a.test.start === "number" ? a.test.start : 0;
      const end = typeof a.test.end === "number" ? a.test.end : 0;
      if (/\bmotionOff\s*\(/u.test(source.slice(start, end))) return true;
    }
  }
  return false;
}

const COLOR_TRANSITION_FIX =
  "avoid animating colors (nsh interpolates them on light/dark theme switches); use `transition-transform`, `transition-opacity`, or `transition-shadow` via `motionClass(...)`, or omit `transition` for instant color feedback";
const UNMANAGED_MOTION_FIX =
  "route UI animations through `design/motion.ts` (`motionClass`, `motionDuration`, `motionOff`, `fadeAnimation`, or `popupTransition`) so the Animations setting and `VIBEVALLEY_NO_ANIMATION=1` can disable them";

function scanColorTransition(out: Finding[], file: string, line: number, text: string, inClassAttr: boolean): void {
  const re = inClassAttr ? COLOR_TRANSITION_CLASS_RE : COLOR_TRANSITION_TIMED_RE;
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) {
    out.push({ file, line, rule: "color-transition", snippet: match[1] ?? match[0].trim(), fix: COLOR_TRANSITION_FIX });
  }
}

function scanUnmanagedMotion(out: Finding[], file: string, line: number, text: string, inMotionCall: boolean): void {
  if (file === MOTION_PRIMITIVE || inMotionCall) return;
  MANAGED_MOTION_CLASS_RE.lastIndex = 0;
  for (const match of text.matchAll(MANAGED_MOTION_CLASS_RE)) {
    out.push({ file, line, rule: "unmanaged-motion", snippet: match[1] ?? match[0].trim(), fix: UNMANAGED_MOTION_FIX });
  }
}

function scanStringValue(out: Finding[], file: string, line: number, text: string, checkColor: boolean, inClassAttr: boolean, inMotionCall: boolean): void {
  pushRegexMatches(
    out,
    file,
    line,
    "arbitrary-tailwind",
    text,
    TAILWIND_ARBITRARY_RE,
    "use canonical theme tokens from `design/tokens.json` (`apps/mac/ui/design/theme.json` / `nsh.json`)",
  );
  scanColorTransition(out, file, line, text, inClassAttr);
  scanUnmanagedMotion(out, file, line, text, inMotionCall);
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
  if (rule === "glyph-icon-substitute" && GLYPH_ICON_EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return RULE_EXEMPTIONS[normalized]?.includes(rule) ?? false;
}

function jsxElementTagName(el: AstNode | undefined): string | undefined {
  if (!el || el.type !== "JSXElement" || !isAstNode(el.openingElement)) return undefined;
  const name = el.openingElement.name;
  return isAstNode(name) && name.type === "JSXIdentifier" && typeof name.name === "string" ? name.name : undefined;
}

function insideExemptGlyphAncestor(ancestors: readonly AstNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const tag = jsxElementTagName(ancestors[i]);
    if (tag !== undefined && GLYPH_ICON_EXEMPT_ANCESTORS.has(tag)) return true;
  }
  return false;
}

function isInlineFlowArrow(node: AstNode, ancestors: readonly AstNode[]): boolean {
  if (jsxElementTagName(node) !== "Text") return false;
  // Nested `<Text>{" → "}</Text>` inside an outer `<Text>` sentence (e.g., `tool args → result`).
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (jsxElementTagName(ancestors[i]) === "Text") return true;
  }
  // `<Text>branch</Text><Text>→</Text><Text>base</Text>` inside a non-interactive container.
  const parent = ancestors[ancestors.length - 1];
  if (!parent || parent.type !== "JSXElement" || !Array.isArray(parent.children)) return false;
  const parentTag = jsxElementTagName(parent);
  if (parentTag === "Button" || parentTag === "ButtonLink" || parentTag === "A" || parentTag === "Link") return false;
  if (isAstNode(parent.openingElement) && isInteractiveJsxElement(parent.openingElement)) return false;

  const significant = parent.children.filter(
    (c): c is AstNode => isAstNode(c) && !(c.type === "JSXText" && typeof c.value === "string" && c.value.trim().length === 0),
  );
  const idx = significant.indexOf(node);
  return idx > 0 && idx + 1 < significant.length && jsxElementTagName(significant[idx - 1]) === "Text" && jsxElementTagName(significant[idx + 1]) === "Text";
}

function collectExprGlyphStrings(expr: AstNode, out: { text: string; offset: number }[]): void {
  const offset = typeof expr.start === "number" ? expr.start : 0;
  if (expr.type === "Literal" && typeof expr.value === "string") {
    out.push({ text: expr.value, offset });
    return;
  }
  if (expr.type === "TemplateLiteral" && Array.isArray(expr.quasis) && Array.isArray(expr.expressions) && expr.expressions.length === 0) {
    const raw = expr.quasis.filter(isAstNode).map(rawTemplateText).join("");
    out.push({ text: raw, offset });
    return;
  }
  if (expr.type === "ConditionalExpression") {
    if (isAstNode(expr.consequent)) collectExprGlyphStrings(expr.consequent, out);
    if (isAstNode(expr.alternate)) collectExprGlyphStrings(expr.alternate, out);
    return;
  }
  if (expr.type === "LogicalExpression") {
    if ((expr.operator === "||" || expr.operator === "??") && isAstNode(expr.left)) collectExprGlyphStrings(expr.left, out);
    if (isAstNode(expr.right)) collectExprGlyphStrings(expr.right, out);
    return;
  }
  if (expr.type === "ParenthesizedExpression" && isAstNode(expr.expression)) {
    collectExprGlyphStrings(expr.expression, out);
  }
}

function scanGlyphIconSubstitutes(out: Finding[], file: string, starts: readonly number[], node: AstNode, ancestors: readonly AstNode[]): void {
  const tag = jsxElementTagName(node);
  if (tag === undefined || !GLYPH_ICON_HOST_TAGS.has(tag)) return;
  if (insideExemptGlyphAncestor(ancestors) || !Array.isArray(node.children)) return;

  const candidates: { text: string; offset: number }[] = [];
  for (const child of node.children) {
    if (!isAstNode(child)) continue;
    const childOffset = typeof child.start === "number" ? child.start : typeof node.start === "number" ? node.start : 0;
    if (child.type === "JSXText" && typeof child.value === "string") {
      candidates.push({ text: child.value, offset: childOffset });
    } else if (child.type === "JSXExpressionContainer" && isAstNode(child.expression)) {
      collectExprGlyphStrings(child.expression, candidates);
    }
  }

  for (const candidate of candidates) {
    const trimmed = candidate.text.trim();
    if (!STANDALONE_GLYPH_ICONS.has(trimmed)) continue;
    if (trimmed === "→" && isInlineFlowArrow(node, ancestors)) continue;
    out.push({
      file,
      line: lineAt(starts, candidate.offset),
      rule: "glyph-icon-substitute",
      snippet: `<${tag}>${trimmed}</${tag}>`,
      fix: GLYPH_ICON_FIX,
    });
  }
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
      scanStringValue(rawFindings, normalized, line, node.value, !isStringParsingHelper(ancestors), insideClassAttr(ancestors), insideMotionCall(ancestors));
      continue;
    }

    if (node.type === "Property") {
      const propName = propertyKeyName(node);
      if (propName === "transitionProperty") {
        const value = stringLiteralOf(node.value);
        if (value !== undefined && COLOR_TRANSITION_PROP_RE.test(value)) {
          rawFindings.push({ file: normalized, line, rule: "color-transition", snippet: `transitionProperty: "${value}"`, fix: COLOR_TRANSITION_FIX });
        } else if (normalized !== MOTION_PRIMITIVE && value !== undefined && !insideMotionOffGuard(ancestors, source)) {
          rawFindings.push({ file: normalized, line, rule: "unmanaged-motion", snippet: `transitionProperty: "${value}"`, fix: UNMANAGED_MOTION_FIX });
        }
        continue;
      }
      if (
        propName === "transitionDuration" &&
        normalized !== MOTION_PRIMITIVE &&
        isAstNode(node.value) &&
        node.value.type === "Literal" &&
        typeof node.value.value === "number" &&
        node.value.value > 0
      ) {
        rawFindings.push({ file: normalized, line, rule: "unmanaged-motion", snippet: `transitionDuration: ${node.value.value}`, fix: UNMANAGED_MOTION_FIX });
        continue;
      }
    }

    if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
      const expressions = Array.isArray(node.expressions) ? node.expressions.filter(isAstNode) : [];
      const inStyleOrJsx = insideStyleOrJsxAttr(ancestors);
      const inClass = insideClassAttr(ancestors);
      const inMotion = insideMotionCall(ancestors);
      for (let i = 0; i < node.quasis.length; i++) {
        const q = node.quasis[i];
        if (!isAstNode(q)) continue;
        const value = rawTemplateText(q);
        const qOffset = typeof q.start === "number" ? q.start : offset;
        const qLine = lineAt(starts, qOffset);

        scanStringValue(rawFindings, normalized, qLine, value, !isStringParsingHelper(ancestors), inClass, inMotion);

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

    if (node.type === "JSXElement") {
      scanGlyphIconSubstitutes(rawFindings, normalized, starts, node, ancestors);
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

    if (node.type === "JSXAttribute") {
      const attrName = jsxAttrName(node);
      const literal = jsxAttrStringValue(node);
      if (attrName === "role" && literal === "checkbox" && normalized !== CHECKBOX_PRIMITIVE) {
        rawFindings.push({
          file: normalized,
          line,
          rule: "raw-control",
          snippet: 'role="checkbox"',
          fix: 'use `Checkbox` from `apps/mac/ui/design/Checkbox.tsx` instead of custom `role="checkbox"`',
        });
      } else if (normalized !== MOTION_PRIMITIVE && attrName === "animation" && literal !== undefined && literal !== "none") {
        rawFindings.push({
          file: normalized,
          line,
          rule: "unmanaged-motion",
          snippet: `animation="${literal}"`,
          fix: UNMANAGED_MOTION_FIX,
        });
      } else if (normalized !== MOTION_PRIMITIVE && attrName !== undefined && POPUP_TRANSITION_ATTRS.has(attrName) && literal !== undefined) {
        rawFindings.push({
          file: normalized,
          line,
          rule: "unmanaged-motion",
          snippet: `${attrName}="${literal}"`,
          fix: UNMANAGED_MOTION_FIX,
        });
      }
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
