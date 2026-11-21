import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSync } from "vite";

const root = resolve(import.meta.dirname, "../..");
const webRoot = resolve(root, "apps/mac/ui/vv/web");

const SCAN_GLOBS = ["app/**/*.{ts,tsx}", "features/**/*.{ts,tsx}", "ui/**/*.{ts,tsx}"] as const;
const EXCLUDE_GLOBS = [
  // Swatch palette & validation helper (defines swatches and hexColor).
  "ui/domain/cast.ts",
  // Runtime token lookup & alpha blender (`tone`, `mix`).
  "ui/tone.ts",
  // Pixel asset registry, sprite manifests, and procedural pixel renderers.
  "ui/pixel/**",
  // Test files and story fixtures.
  "**/*.test.*",
  "**/*.story.*",
  // GitHub Linguist external programming-language palette.
  "features/repo/repos.ts",
  // Serialized Excalidraw SVG export fills and isolated WebView stylesheet.
  "features/artifact/WhiteboardView.tsx",
  // ISO QR specification requires strict #ffffff / #000000 contrast regardless of theme.
  "ui/Qr.tsx",
] as const;

const SWITCH_PRIMITIVE = "apps/mac/ui/vv/web/ui/layout.tsx";
const CHECKBOX_PRIMITIVE = "apps/mac/ui/vv/web/ui/Checkbox.tsx";

const HEX_LITERAL_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F-])/gu;
const RGB_CALL_RE = /\brgba?\s*\(/gu;
const TAILWIND_ARBITRARY_RE = /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via|rounded|shadow)-\[[^\]]+\]/gu;
const HEX_ALPHA_SUFFIX_RE = /^[0-9a-fA-F]{2}$/u;

export type ViolationRule = "hardcoded-color" | "arbitrary-tailwind" | "raw-control";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: ViolationRule;
  readonly snippet: string;
  readonly fix: string;
}

export interface BaselineEntry {
  readonly file: string;
  readonly line: number;
  readonly rule: ViolationRule;
  readonly snippet: string;
}

/** Narrow rule-level exemptions for files that legitimately deviate on one rule only. */
const RULE_EXEMPTIONS: Readonly<Record<string, readonly ViolationRule[]>> = {
  // 5-state PKM task marker (TODO/DOING/DONE/WAIT/CANCELED), not binary <Checkbox>.
  "apps/mac/ui/vv/web/features/pkm/OutlineEditor.tsx": ["raw-control"],
  // Third-party WeChat/Feishu/QQ brand stand-ins and QR quiet frame.
  "apps/mac/ui/vv/web/features/connector/ConnectorsPage.tsx": ["hardcoded-color"],
};

/** Temporary Round 1 -> Round 2 baseline (strictly the 5 files / 20 findings to retire in Round 2). */
export const ROUND2_BASELINE: readonly BaselineEntry[] = [
  { file: "apps/mac/ui/vv/web/features/agent/AgentConfig.tsx", line: 353, rule: "raw-control", snippet: 'role="checkbox"' },
  { file: "apps/mac/ui/vv/web/features/agent/AgentsPage.tsx", line: 310, rule: "raw-control", snippet: "<Switch" },
  {
    file: "apps/mac/ui/vv/web/features/agent/AgentsPage.tsx",
    line: 326,
    rule: "hardcoded-color",
    snippet: "${hexColor(props.agent.look.hat)}29",
  },
  {
    file: "apps/mac/ui/vv/web/features/runtime/RuntimesPage.tsx",
    line: 129,
    rule: "hardcoded-color",
    snippet: "${hexColor(props.info.preset.look.hat)}33",
  },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 181, rule: "hardcoded-color", snippet: "#e5a93c" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 183, rule: "hardcoded-color", snippet: "#b4cb7c" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 185, rule: "hardcoded-color", snippet: "#c8a46e" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 187, rule: "hardcoded-color", snippet: "#74a046" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 190, rule: "hardcoded-color", snippet: "#efb84e" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 192, rule: "hardcoded-color", snippet: "#b8402f" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 196, rule: "hardcoded-color", snippet: "#e2c995" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 198, rule: "hardcoded-color", snippet: "#b8402f" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 203, rule: "hardcoded-color", snippet: "#4f8fbd" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 205, rule: "hardcoded-color", snippet: "#3f6427" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 207, rule: "hardcoded-color", snippet: "#67482d" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 209, rule: "hardcoded-color", snippet: "#e2c995" },
  { file: "apps/mac/ui/vv/web/features/session/runs.ts", line: 212, rule: "hardcoded-color", snippet: "#9b7550" },
  { file: "apps/mac/ui/vv/web/ui/domain/Face.tsx", line: 91, rule: "hardcoded-color", snippet: "#dcebc8" },
  { file: "apps/mac/ui/vv/web/ui/domain/Face.tsx", line: 130, rule: "hardcoded-color", snippet: "#cfe6f5" },
  { file: "apps/mac/ui/vv/web/ui/domain/Face.tsx", line: 131, rule: "hardcoded-color", snippet: "#cfe6f5" },
];

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
    "use canonical theme tokens from `design/tokens.json` (`apps/mac/ui/vv/theme.json` / `nsh.json`)",
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
    'use a semantic token class, `tone("...")`, or `mix("...", alpha)` from `ui/tone.ts`',
  );
  pushRegexMatches(out, file, line, "hardcoded-color", masked, RGB_CALL_RE, 'use `mix("...", alpha)` from `ui/tone.ts` instead of `rgb()` / `rgba()`');
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
              fix: 'use `mix("...", alpha)` or a helper on `ui/tone.ts` instead of hex-alpha string concatenation',
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
          fix: "use `Toggle` from `apps/mac/ui/vv/web/ui/layout.tsx` instead of raw `<Switch`",
        });
      }
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
        fix: 'use `Checkbox` from `apps/mac/ui/vv/web/ui/Checkbox.tsx` instead of custom `role="checkbox"`',
      });
    }
  }

  return rawFindings.filter((f) => !isRuleExempt(f.file, f.rule));
}

export function listWebUiFiles(): string[] {
  return globSync([...SCAN_GLOBS], {
    cwd: webRoot,
    exclude: [...EXCLUDE_GLOBS],
  })
    .map((f) => `apps/mac/ui/vv/web/${f.replaceAll("\\", "/")}`)
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

function baselineKey(entry: Pick<BaselineEntry, "file" | "line" | "rule" | "snippet">): string {
  return `${entry.file}:${entry.line}:${entry.rule}:${entry.snippet}`;
}

export function filterBaselineViolations(findings: readonly Finding[], baseline: readonly BaselineEntry[] = ROUND2_BASELINE): Finding[] {
  const allowed = new Set(baseline.map(baselineKey));
  return findings.filter((f) => !allowed.has(baselineKey(f)));
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
  const unexpected = filterBaselineViolations(findings);
  if (unexpected.length > 0) {
    for (const f of unexpected) {
      console.error(`${f.file}:${f.line} [${f.rule}] ${f.snippet}\n  Fix: ${f.fix}`);
    }
    console.error(`\nFound ${unexpected.length} un-allowlisted design-token violation(s).`);
    process.exit(1);
  }
}
