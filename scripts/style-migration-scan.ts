import { transform } from "lightningcss";
import { parse } from "parse5";
import { parseSync } from "vite-plus";

import { styleFingerprint } from "./style-migration-ownership";

export interface StyleFinding {
  category: string;
  path: string;
  offset: number;
  evidence: string;
}
export interface StyleScan {
  parsed: boolean;
  expressions: number;
  classifications: { offset: number; kind: string }[];
  findings: StyleFinding[];
}
type Node = Readonly<Record<string, unknown>>;
const nodeOf = (input: unknown): Node => (typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {});
const nameOf = (input: unknown): string | undefined => {
  const node = nodeOf(input);
  return typeof node.name === "string" ? node.name : typeof node.value === "string" ? node.value : undefined;
};
const childrenOf = (node: Node, key: string): unknown[] => (Array.isArray(node[key]) ? node[key] : []);
const walk = (input: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(input)) {
    input.forEach((value) => walk(value, visit));
    return;
  }
  if (typeof input !== "object" || input === null) return;
  const node = nodeOf(input);
  if (typeof node.type === "string") visit(node);
  Object.values(node).forEach((value) => walk(value, visit));
};
const offsetOf = (node: Node) => (typeof node.start === "number" ? node.start : 0);
const classNames = new Set(["class", "className", "classList"]);
const legacyHelpers = new Set(["cx", "cn", "clsx", "classNames", "cva", "twMerge"]);

export function scanStyleSource(
  path: string,
  text: string,
  semanticClasses: ReadonlySet<string> = new Set(),
  reviewedStyles: ReadonlyMap<string, string> = new Map(),
): StyleScan {
  const result: StyleScan = { parsed: true, expressions: 0, classifications: [], findings: [] };
  const finding = (category: string, node: Node, evidence?: string) =>
    result.findings.push({
      category,
      path,
      offset: offsetOf(node),
      evidence: evidence ?? text.slice(offsetOf(node), typeof node.end === "number" ? node.end : offsetOf(node) + 100),
    });
  const classify = (node: Node, kind: string) => result.classifications.push({ offset: offsetOf(node), kind });
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(path, text, { lang: /\.[cm]?tsx$/u.test(path) ? "tsx" : /\.[cm]?jsx$/u.test(path) ? "jsx" : /\.[cm]?js$/u.test(path) ? "js" : "ts" });
  } catch (error) {
    result.parsed = false;
    finding("parse-error", {}, String(error));
    return result;
  }
  if (parsed.errors.length > 0) {
    result.parsed = false;
    for (const error of parsed.errors) finding("parse-error", {}, error.message);
  }
  const bindings = new Map<string, unknown[]>();
  const stylexNamespaces = new Set<string>();
  const stylexAttrs = new Set<string>();
  const nativeComponents = new Set<string>();
  const nativeStyleOffsets = new Set<number>();
  const usedReviews = new Set<string>();
  const parameterScopes: { start: number; end: number; parameters: Map<string, Node> }[] = [];
  walk(parsed.program, (node) => {
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(node.type))) {
      const parameters = new Map<string, Node>();
      for (const input of childrenOf(node, "params")) {
        const parameter = nodeOf(input);
        const name = nameOf(parameter);
        if (name !== undefined) parameters.set(name, nodeOf(nodeOf(parameter.typeAnnotation).typeAnnotation));
      }
      parameterScopes.push({ start: offsetOf(node), end: typeof node.end === "number" ? node.end : 0, parameters });
    }
    if (node.type === "VariableDeclarator") {
      const name = nameOf(node.id);
      if (name !== undefined) bindings.set(name, [...(bindings.get(name) ?? []), node.init]);
    }
    if (node.type === "ImportDeclaration") {
      const source = nameOf(node.source);
      if (source?.includes("tailwind") === true) finding("tailwind-import", node, source);
      if (path.startsWith("apps/site/") && source !== undefined && /^(?:astro(?:$|[:/])|@astrojs\/)/u.test(source))
        finding("website-astro-import", node, source);
      if (path.startsWith("apps/site/") && source !== undefined && /^(?:react(?:$|[-/])|motion\/react(?:$|[-/]))/u.test(source))
        finding("website-react-import", node, source);
      if (
        path.startsWith("apps/mobile/") &&
        ["react-native", "react-native-webview", "react-native-safe-area-context", "expo-camera", "expo-status-bar"].includes(source ?? "")
      )
        for (const value of childrenOf(node, "specifiers")) {
          const local = nameOf(nodeOf(value).local);
          if (local !== undefined) nativeComponents.add(local);
        }
      if (source === "@stylexjs/stylex")
        for (const value of childrenOf(node, "specifiers")) {
          const specifier = nodeOf(value);
          const local = nameOf(specifier.local);
          if (local === undefined) continue;
          if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") stylexNamespaces.add(local);
          if (nameOf(specifier.imported) === "attrs") stylexAttrs.add(local);
        }
      if (source !== undefined && /(?:^|\/)positioner(?:\.ts)?$/u.test(source))
        for (const value of childrenOf(node, "specifiers")) {
          const specifier = nodeOf(value);
          const local = nameOf(specifier.local);
          if (local !== undefined && ["styleProps", "positionerAttrs"].includes(nameOf(specifier.imported) ?? "")) stylexAttrs.add(local);
        }
    }
  });
  const nativeAliases = new Set<string>();
  for (const [name, values] of bindings) {
    if (values.length !== 1) continue;
    let value = nodeOf(values[0]);
    while (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(String(value.type))) value = nodeOf(value.expression);
    if (value.type === "Identifier" && nativeComponents.has(nameOf(value) ?? "")) nativeAliases.add(name);
  }
  walk(parsed.program, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const name = nameOf(node.name);
    if (name === undefined || (!nativeComponents.has(name) && !nativeAliases.has(name)) || (bindings.has(name) && !nativeAliases.has(name))) return;
    for (const attribute of childrenOf(node, "attributes")) {
      const attr = nodeOf(attribute);
      if (attr.type === "JSXAttribute" && nameOf(attr.name) === "style") nativeStyleOffsets.add(offsetOf(attr));
    }
  });
  const attrsCall = (input: unknown): boolean => {
    const node = nodeOf(input);
    if (node.type !== "CallExpression") return false;
    const callee = nodeOf(node.callee);
    const name = nameOf(callee);
    return (
      (name !== undefined && stylexAttrs.has(name)) ||
      (callee.type === "MemberExpression" && nameOf(callee.property) === "attrs" && stylexNamespaces.has(nameOf(callee.object) ?? ""))
    );
  };
  const classes = (input: unknown, seen = new Set<string>()): void => {
    const node = nodeOf(input);
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "string") {
          for (const token of node.value.split(/\s+/u).filter(Boolean)) {
            if (semanticClasses.has(token)) classify(node, "permitted-semantic-class");
            else finding("unconverted-class-token", node, token);
          }
        } else if (node.value === null || node.value === false) classify(node, "empty-class");
        else finding("unknown-class-expression", node);
        return;
      case "JSXExpressionContainer":
        classes(node.expression, seen);
        return;
      case "ArrayExpression":
        childrenOf(node, "elements").forEach((value) => {
          if (value !== null) classes(value, seen);
        });
        return;
      case "ConditionalExpression":
        classes(node.consequent, seen);
        classes(node.alternate, seen);
        return;
      case "LogicalExpression":
        if (node.operator !== "&&") classes(node.left, seen);
        classes(node.right, seen);
        return;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        classes(node.expression, seen);
        return;
      case "TemplateLiteral":
        if (childrenOf(node, "expressions").length > 0) {
          finding("unknown-class-template", node);
          return;
        }
        for (const value of childrenOf(node, "quasis"))
          classes({ type: "Literal", start: offsetOf(nodeOf(value)), value: nodeOf(nodeOf(value).value).cooked }, seen);
        return;
      case "Identifier": {
        const name = nameOf(node);
        if (name === "undefined") {
          classify(node, "empty-class");
          return;
        }
        const values = name === undefined ? undefined : bindings.get(name);
        if (name !== undefined && values === undefined) {
          const scope = parameterScopes
            .filter((scope) => scope.start <= offsetOf(node) && scope.end >= offsetOf(node) && scope.parameters.has(name))
            .toSorted((a, b) => b.start - a.start)[0];
          const annotation = scope?.parameters.get(name);
          const literals = annotation?.type === "TSUnionType" ? childrenOf(annotation, "types").map(nodeOf) : annotation ? [annotation] : [];
          if (literals.length > 0 && literals.every((literal) => literal.type === "TSLiteralType" && typeof nodeOf(literal.literal).value === "string")) {
            for (const literal of literals) classes(literal.literal, seen);
            return;
          }
        }
        if (name === undefined || values?.length !== 1 || seen.has(name)) {
          finding("unresolved-class-binding", node);
          return;
        }
        classes(values[0], new Set([...seen, name]));
        return;
      }
      case "MemberExpression":
        if (nameOf(node.property) === "class" && attrsCall(node.object)) {
          classify(node, "stylex-attrs");
          return;
        }
        if (nameOf(node.object) === "props" && ["class", "className"].includes(nameOf(node.property) ?? "")) {
          classify(node, "forwarded-class-contract");
          return;
        }
        finding("unresolved-class-member", node);
        return;
      case "CallExpression": {
        const helper = nameOf(node.callee);
        if (helper !== undefined && legacyHelpers.has(helper)) {
          finding("legacy-class-helper", node, helper);
          childrenOf(node, "arguments").forEach((value) => classes(value, seen));
        } else finding("unknown-class-call", node);
        return;
      }
      case "ObjectExpression":
        for (const value of childrenOf(node, "properties")) {
          const property = nodeOf(value);
          const name = property.computed === true ? undefined : nameOf(property.key);
          if (name === undefined) finding("unknown-class-map", property);
          else classes({ type: "Literal", start: offsetOf(property), value: name }, seen);
        }
        return;
      default:
        finding("unknown-class-expression", node);
        return;
    }
  };
  walk(parsed.program, (node) => {
    if (node.type === "JSXAttribute" && classNames.has(nameOf(node.name) ?? "")) {
      result.expressions++;
      classes(node.value);
    }
    if (node.type === "JSXAttribute" && nameOf(node.name) === "style") {
      const value = nodeOf(nodeOf(node.value).expression);
      const fingerprint = styleFingerprint(node);
      const owner = reviewedStyles.get(fingerprint);
      if (value.type === "MemberExpression" && nameOf(value.property) === "style" && attrsCall(value.object)) classify(node, "stylex-inline-variables");
      else if (nativeStyleOffsets.has(offsetOf(node))) classify(node, "react-native-style-boundary");
      else if (owner !== undefined) {
        usedReviews.add(fingerprint);
        classify(node, `reviewed-native-style:${owner}`);
      } else finding("unreviewed-inline-style", node);
    }
    if (node.type === "JSXSpreadAttribute" && attrsCall(node.argument)) classify(node, "stylex-attrs");
    if (node.type === "AssignmentExpression") {
      const left = nodeOf(node.left);
      if (left.type === "MemberExpression" && nameOf(left.property) === "className") {
        result.expressions++;
        classes(node.right);
      }
    }
    if (node.type === "CallExpression") {
      const callee = nodeOf(node.callee);
      if (
        stylexNamespaces.has(nameOf(callee.object) ?? "") &&
        ["create", "defineConsts", "defineVars", "createTheme", "keyframes", "defineMarker", "props"].includes(nameOf(callee.property) ?? "")
      ) {
        classify(node, `stylex-${nameOf(callee.property) ?? "unknown"}`);
        for (const argument of childrenOf(node, "arguments"))
          walk(argument, (property) => {
            if (property.type !== "Property" || nameOf(property.key) === "content") return;
            const value = nodeOf(property.value);
            if (value.type === "Literal" && typeof value.value === "string" && /var\(--color-[\w-]+\)[\da-f]{2}\b/iu.test(value.value))
              finding(
                "invalid-color-variable-suffix",
                value,
                `${value.value}; Fix: use an owned alpha-color token, not a suffix on var(). See docs/style/design.md.`,
              );
          });
      }
      const args = childrenOf(node, "arguments");
      const method = nameOf(callee.property);
      if (method === "setAttribute" && nameOf(args[0]) === "class") {
        result.expressions++;
        classes(args[1]);
      }
      if (nameOf(nodeOf(callee.object).property) === "classList" && ["add", "remove", "toggle", "replace"].includes(method ?? "")) {
        result.expressions++;
        (method === "toggle" ? args.slice(0, 1) : args).forEach((argument) => classes(argument));
      }
    }
    if (
      node.type === "Property" &&
      ["sortTailwindcss", "tailwindConfig", "tailwindStylesheet", "tailwindFunctions", "tailwindAttributes"].includes(nameOf(node.key) ?? "")
    )
      finding("tailwind-configuration", node);
    if (node.type === "TSPropertySignature" && ["class", "className"].includes(nameOf(node.key) ?? "")) {
      const annotation = nodeOf(nodeOf(node.typeAnnotation).typeAnnotation);
      const source = text.slice(offsetOf(annotation), typeof annotation.end === "number" ? annotation.end : offsetOf(annotation));
      if (/JSX\.|ComponentProps|StyleXStyles/u.test(source)) classify(node, "typed-class-boundary");
      else finding("unconverted-styled-contract", node);
    }
  });
  for (const [fingerprint, owner] of reviewedStyles) if (!usedReviews.has(fingerprint)) finding("stale-inline-review", {}, owner);
  if (result.expressions === 0 && result.classifications.length === 0) classify({}, "parsed-non-style-source");
  return result;
}

export function scanStyleHtml(path: string, text: string, semanticClasses: ReadonlySet<string> = new Set()): StyleScan {
  const result: StyleScan = { parsed: true, expressions: 0, classifications: [], findings: [] };
  const document = parse(text, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      result.parsed = false;
      result.findings.push({ category: "html-parse-error", path, offset: error.startOffset, evidence: error.code });
    },
  });
  const visit = (input: unknown): void => {
    const node = nodeOf(input);
    const location = nodeOf(node.sourceCodeLocation);
    const offset = typeof location.startOffset === "number" ? location.startOffset : 0;
    const attrs = childrenOf(node, "attrs").map(nodeOf);
    for (const attr of attrs)
      if (attr.name === "class" && typeof attr.value === "string") {
        result.expressions++;
        for (const token of attr.value.split(/\s+/u).filter(Boolean)) {
          if (semanticClasses.has(token)) result.classifications.push({ offset, kind: "permitted-semantic-class" });
          else result.findings.push({ category: "unconverted-class-token", path, offset, evidence: token });
        }
      }
    for (const attr of attrs) {
      if (attr.name === "style") result.findings.push({ category: "unreviewed-inline-style", path, offset, evidence: String(attr.value) });
      if (typeof attr.name === "string" && /^on[a-z]+$/u.test(attr.name) && typeof attr.value === "string") {
        const handler = scanStyleSource(`${path}.handler.js`, `function handler(event) { ${attr.value} }`, semanticClasses);
        result.parsed &&= handler.parsed;
        result.expressions += handler.expressions;
        result.findings.push(...handler.findings.map((finding) => ({ ...finding, path, offset })));
        result.classifications.push({ offset, kind: "inline-event-handler" });
      }
    }
    const body = childrenOf(node, "childNodes")
      .map(nodeOf)
      .map((child) => (typeof child.value === "string" ? child.value : ""))
      .join("");
    if (node.nodeName === "style") result.findings.push(...scanStyleCss(path, body).map((finding) => ({ ...finding, offset: offset + finding.offset })));
    if (node.nodeName === "script" && body.trim().length > 0) {
      const type = attrs.find((attr) => attr.name === "type")?.value;
      if (type === "application/ld+json" || type === "application/json") {
        try {
          JSON.parse(body);
          result.classifications.push({ offset, kind: "static-json-script" });
        } catch (error) {
          result.parsed = false;
          result.findings.push({ category: "json-parse-error", path, offset, evidence: String(error) });
        }
      } else if (type === undefined || type === "module" || type === "text/javascript") {
        const script = scanStyleSource(`${path}.inline.js`, body, semanticClasses);
        result.parsed &&= script.parsed;
        result.expressions += script.expressions;
        result.classifications.push(...script.classifications.map((classification) => ({ ...classification, offset: offset + classification.offset })));
        result.findings.push(...script.findings.map((finding) => ({ ...finding, path, offset: offset + finding.offset })));
      } else {
        result.parsed = false;
        result.findings.push({ category: "unknown-script-type", path, offset, evidence: JSON.stringify(type) ?? "unknown" });
      }
    }
    childrenOf(node, "childNodes").forEach(visit);
    if (node.content !== undefined) visit(node.content);
  };
  visit(document);
  return result;
}

export function scanStyleCss(path: string, text: string): StyleFinding[] {
  const findings: StyleFinding[] = [];
  try {
    transform({ filename: path, code: Buffer.from(text), errorRecovery: false });
  } catch (error) {
    findings.push({ category: "css-parse-error", path, offset: 0, evidence: String(error) });
  }
  const comments = text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => " ".repeat(comment.length));
  const code = comments.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, (value: string, offset: number) =>
    /@import\s+(?:url\(\s*)?$/u.test(comments.slice(0, offset)) ? value : " ".repeat(value.length),
  );
  for (const match of code.matchAll(/@(?:tailwind|apply|theme|utility|custom-variant)\b|@import\s+[^;]*tailwind[^;]*|--tw-[\w-]+/gu))
    findings.push({ category: "tailwind-css", path, offset: match.index, evidence: match[0] });
  return findings;
}
