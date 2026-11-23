import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { definePlugin, defineRule, type ESTree, type Context, type Scope } from "vite-plus/lint/plugins";

/** Diagnostics include a replacement rather than only a prohibition; the named See path is checked by tests. */
export const says = (wrong: string, fix: string, see: string) => `${wrong}. Fix: ${fix}. See ${see}`;

const repo = resolve(import.meta.dirname, "../..");

const clockCall = (node: ESTree.Node, context: Context): string | undefined => {
  if (node.type === "MemberExpression") {
    const owner = clockCall(node.object, context);
    const key = !node.computed && node.property.type === "Identifier" ? node.property.name : node.property.type === "Literal" ? node.property.value : undefined;
    return owner !== undefined && typeof key === "string" ? [owner, key].filter(Boolean).join(".") : undefined;
  }
  if (node.type !== "Identifier") return undefined;
  for (let scope: Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const definition = scope.set.get(node.name)?.defs[0];
    if (!definition) continue;
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") return undefined;
    const source = definition.parent.source.value;
    if (!["node:timers", "timers", "node:timers/promises", "timers/promises"].includes(source)) return undefined;
    const imported = definition.node;
    const name = imported.type === "ImportSpecifier" ? (imported.imported.type === "Identifier" ? imported.imported.name : imported.imported.value) : "";
    return name;
  }
  return node.name === "globalThis" ? "" : node.name;
};
const timerCalls = new Set(["setTimeout", "setInterval"]);

const noTestSleep = defineRule({
  meta: {
    messages: {
      sleep: says(
        "a test that waits a set time guesses how long the work takes: slow when it is quick, flaky when it is slow",
        "wait for a condition with `vi.waitFor` or the native app's `waitUntil`; advance fake timers with `vi.advanceTimersByTimeAsync(ms)`",
        "apps/mac/ui/app/scenarios.test.tsx",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        const name = clockCall(c, context);
        if (timerCalls.has(name ?? "") || (c.type === "MemberExpression" && c.property.type === "Identifier" && c.property.name === "waitForTimeout"))
          context.report({ node, messageId: "sleep" });
      },
    };
  },
});

const noCommentDivider = defineRule({
  meta: {
    messages: {
      divider: says(
        "a divider titles or fences off code, which says nothing the code does not",
        "delete it; a stretch that needs a name becomes a function with that name, and a comment stays only to say why",
        "docs/style/code.md",
      ),
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const trimmed = comment.value.trim();
          if (/[─━═]{2}/u.test(comment.value) || /^[-=*#~_/\s]{4,}$/u.test(trimmed) || /^[-=]{3,}\s|\s[-=]{3,}$/u.test(trimmed))
            context.report({ loc: comment.loc, messageId: "divider" });
        }
      },
    };
  },
});

/** A style object every value of which is written out: nothing in it is worked out at run time. */
function fixedStyle(node: ESTree.Node): boolean {
  if (node.type === "Literal") return typeof node.value === "string";
  if (node.type !== "ObjectExpression" || node.properties.length === 0) return false;
  return node.properties.every(
    (entry) =>
      entry.type === "Property" &&
      !entry.computed &&
      ((entry.value.type === "Literal" && (typeof entry.value.value === "string" || typeof entry.value.value === "number")) ||
        (entry.value.type === "TemplateLiteral" && entry.value.expressions.length === 0)),
  );
}

/** nsh built-in host elements take `class` (Tailwind utilities, vv-tailwind), just like HTML tags on the site. */
const nshElements = new Set(["View", "Text", "Scroll", "Image", "Input", "Canvas", "WebView", "List"]);

const styleAttrs = defineRule({
  meta: {
    messages: {
      classAttr: says(
        "`{{attr}}` is not how Solid 2 takes classes, so the element gets none",
        "write `class`: a string, or an array whose false entries are left out (Tailwind utilities, vv-tailwind)",
        "apps/site/src/ui/ui.tsx",
      ),
      fixedStyle: says(
        "a `style` with only written-out values is a class that skips the tokens and the lint on them",
        "write the Tailwind utilities in `class` (vv-tailwind); `style` is for a value worked out at run time, such as a width in percent",
        "apps/site/src/ui/ui.tsx",
      ),
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const attr = node.name.name;
        if (attr === "className" || attr === "classList") context.report({ node, messageId: "classAttr", data: { attr } });
        // A component's `style` is a prop it hands on (a story showing that it does); the element's own looks are what count.
        const tag = node.parent.type === "JSXOpeningElement" && node.parent.name.type === "JSXIdentifier" ? node.parent.name.name : "";
        const element = /^[a-z]/u.test(tag) || nshElements.has(tag);
        if (attr !== "style" || node.value === null || !element) return;
        const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (fixedStyle(value)) context.report({ node, messageId: "fixedStyle" });
      },
    };
  },
});

// Chinese punctuation too: a word joined to its neighbor with 「：」 or 「、」 in code reads as Chinese in an English farm.
const han = /[\p{Script=Han}、，。：；（）！？「」【】〔〕]/u;

/** The catalog a file's words belong in: the native app's pages have one per feature, everything else shares one. */
export function catalogOf(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  if (/\/apps\/mac\/ui\/workspace\//u.test(normalized)) return "web.shell";
  const rest = /\/apps\/mac\/ui\/(.*)$/u.exec(normalized)?.[1];
  if (rest === undefined) return "shared";
  const parts = rest.split("/");
  const top = parts[0];
  const sub = parts.slice(1, -1);
  let folders: string[];
  if (top === "design") folders = ["ui", ...sub];
  else if (top === "features" || top === "infra") folders = sub;
  else if (top === "farm") folders = ["farm", ...sub];
  else folders = [];
  for (let n = folders.length; n > 0; n--) {
    const name = ["web", ...folders.slice(0, n)].join(".");
    if (existsSync(resolve(repo, "crates/i18n/locales/zh", `${name}.json`))) return name;
  }
  return "web";
}

const noCjkLiteral = defineRule({
  meta: {
    messages: {
      cjk: says(
        "words written in code are not translated: an English farm would show them in Chinese",
        'add a key to crates/i18n/locales/zh/{{catalog}}.json and en/{{catalog}}.json, run `vp run i18n:gen`, and write `t("{{catalog}}.<key>")`',
        "packages/i18n/README.md",
      ),
    },
  },
  create(context) {
    const data = { catalog: catalogOf(context.filename) };
    return {
      // Read as written: a character spelled as a \u escape is a code point on purpose (a keystroke an input method
      // types), not words.
      Literal(node) {
        if (typeof node.value === "string" && han.test(node.raw ?? node.value)) context.report({ node, messageId: "cjk", data });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((q) => han.test(q.value.raw))) context.report({ node, messageId: "cjk", data });
      },
      JSXText(node) {
        if (han.test(node.value)) context.report({ node, messageId: "cjk", data });
      },
    };
  },
});

/** Both paths are relative to the package's src. */
function joinPath(from: string, spec: string) {
  const out = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

const oneAbsent = defineRule({
  meta: {
    messages: {
      both: says(
        "a type with both null and undefined has two words for one thing, and every reader must check for both",
        "inside the program `T | undefined` (or an optional field); where null comes in from outside (JSON, a library), turn it into undefined right there (`x ?? undefined`)",
        "docs/style/code.md",
      ),
    },
  },
  create(context) {
    return {
      TSUnionType(node) {
        const kinds = new Set(node.types.map((t) => t.type));
        if (kinds.has("TSNullKeyword") && kinds.has("TSUndefinedKeyword")) context.report({ node, messageId: "both" });
      },
    };
  },
});

const globals = new Set(["window", "globalThis", "self"]);
const isGlobal = (node: { type: string } | undefined) =>
  node?.type === "Identifier" && "name" in node && typeof node.name === "string" && globals.has(node.name);

const globalDoors = defineRule({
  meta: {
    messages: {
      cast: says(
        "a cast of the global object reads a global nobody declared, so the two sides that share it can drift apart",
        "declare it once in its door (`declare global { interface Window { … } }`) and read `window.x` with that type",
        "packages/protocol/src/host.ts",
      ),
      assign: says(
        "Object.assign or defineProperty onto the global object sets a global nobody declared",
        "declare it in its door and set it by its name (`window.x = …`)",
        "packages/protocol/src/host.ts",
      ),
      declare: says(
        "a global is a contract between two worlds (a page and its shell, a test and the program it drives), declared in one place",
        "move this declaration into the door that owns it, or list a new door in vite.config.ts with `{ door: true }`",
        "packages/protocol/src/host.ts",
      ),
    },
    // { door: true } in a door file: it may declare globals.
    schema: [{ type: "object", properties: { door: { type: "boolean" } }, additionalProperties: false }],
  },
  create(context) {
    const options: unknown = context.options[0];
    const door = typeof options === "object" && options !== null && "door" in options && options.door === true;
    return {
      TSAsExpression(node) {
        if (isGlobal(node.expression)) context.report({ node, messageId: "cast" });
      },
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "Object" &&
          c.property.type === "Identifier" &&
          (c.property.name === "assign" || c.property.name === "defineProperty") &&
          isGlobal(node.arguments[0])
        )
          context.report({ node, messageId: "assign" });
      },
      TSModuleDeclaration(node) {
        if (!door && node.id.type === "Identifier" && node.id.name === "global") context.report({ node, messageId: "declare" });
      },
    };
  },
});

const childProcessDoor = defineRule({
  meta: {
    messages: {
      spawn: says(
        "a process started here is one more place that must kill its whole group on a timeout and keep what it printed, which the doors already do",
        "start it from a script (scripts/, or the package's own scripts/); a process shipped code must start gets one door file, excluded by name from this rule in vite.config.ts",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if ((node.source.value === "node:child_process" || node.source.value === "child_process") && node.importKind !== "type")
          context.report({ node, messageId: "spawn" });
      },
    };
  },
});

/** The folder of the package a path is in (the nearest package.json above it), and that package's name. */
const packages = new Map<string, { dir: string; name: string } | undefined>();
function packageOf(path: string): { dir: string; name: string } | undefined {
  const dir = dirname(path);
  if (packages.has(dir)) return packages.get(dir);
  const manifest = resolve(dir, "package.json");
  const found = existsSync(manifest)
    ? { dir, name: /"name":\s*"([^"]+)"/u.exec(readFileSync(manifest, "utf8"))?.[1] ?? dir }
    : dir === dirname(dir)
      ? undefined
      : packageOf(dir);
  packages.set(dir, found);
  return found;
}

const noCrossPackagePath = defineRule({
  meta: {
    messages: {
      cross: says(
        "`{{spec}}` reaches into {{to}}'s files by a path: it breaks when either moves, and skips what {{to}} says it gives (its package.json exports)",
        "import it by its name (`{{to}}/…`), adding an exports entry to {{to}}'s package.json and {{to}} to this package's dependencies if they are missing",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    const from = packageOf(context.filename);
    if (from === undefined) return {};
    const check = (source: { type: string; value?: unknown; range: [number, number] } | null | undefined) => {
      if (source?.type !== "Literal" || typeof source.value !== "string" || !source.value.startsWith(".")) return;
      const target = resolve(dirname(context.filename), source.value);
      // Shared static assets (`assets/*.json`) live at the repository root, not in another workspace package.
      if (target.startsWith(`${resolve(repo, "assets")}/`)) return;
      const to = packageOf(target);
      if (to !== undefined && to.dir !== from.dir) context.report({ node: source, messageId: "cross", data: { spec: source.value, to: to.name } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
    };
  },
});

const hostIoModules = new Set(["node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http", "node:https"]);
const nonBaseFolders = new Set(["infra", "ui", "state", "features", "sections"]);

const subpackageLayersRule = defineRule({
  meta: {
    messages: {
      baseIo: says(
        "src/base holds pure computation and data definitions, never host I/O ({{source}})",
        "move I/O and host adapters into src/infra (or the owning slice) and pass plain values into base",
        "docs/style/module-design.md",
      ),
      baseUpward: says(
        "src/base is the lowest layer of its package and cannot import upward into {{target}}",
        "move the shared pure definition down into src/base, or move this caller up into {{target}}",
        "docs/style/module-design.md",
      ),
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (/\.(?:test|spec|stories)\.tsx?$/u.test(normalized)) return {};
    const match = /\/(?:apps|packages)\/[^/]+\/src\/(.+)$/u.exec(normalized);
    if (!match) return {};
    const at = match[1];
    if (at?.split("/")[0] !== "base") return {};

    const checkSpec = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec !== "string" || at === undefined) return;
      if (hostIoModules.has(spec)) {
        context.report({ node, messageId: "baseIo", data: { source: spec } });
        return;
      }
      if (spec.startsWith(".") || spec.startsWith("#/")) {
        const target = spec.startsWith("#/") ? spec.slice(2) : joinPath(at, spec);
        const targetTop = target.split("/")[0] ?? "";
        if (nonBaseFolders.has(targetTop)) context.report({ node, messageId: "baseUpward", data: { target: `src/${targetTop}` } });
      }
    };

    return {
      ImportDeclaration: (node) => checkSpec(node.source, node.source.value),
      ExportNamedDeclaration: (node) => (node.source ? checkSpec(node.source, node.source.value) : undefined),
      ExportAllDeclaration: (node) => checkSpec(node.source, node.source.value),
      ImportExpression: (node) => (node.source.type === "Literal" ? checkSpec(node.source, node.source.value) : undefined),
    };
  },
});

const uiLayers = new Set(["infra", "design", "features", "app", "farm", "workspace"]);
const allowedUiImports: Readonly<Record<string, ReadonlySet<string>>> = {
  infra: new Set(["infra"]),
  design: new Set(["infra", "design"]),
  features: new Set(["infra", "design", "features"]),
  app: new Set(["infra", "design", "features", "app"]),
  farm: new Set(["infra", "design", "features", "farm"]),
  workspace: new Set(["infra", "design", "features", "workspace"]),
};

const uiLayerBoundaries = defineRule({
  meta: {
    messages: {
      layer: says(
        "apps/mac/ui/{{from}} cannot import from apps/mac/ui/{{to}}: UI layers flow one way (infra -> design -> features -> app | farm | workspace)",
        "move the shared code down to a lower layer (infra or design), or lift the caller to the composition layer",
        "docs/subsystems/app.md",
      ),
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (
      /\.(?:test|spec|story)\.tsx?$/u.test(normalized) ||
      /(?:^|\/)story\.tsx$/u.test(normalized) ||
      /\/(?:stories|fixtures)\//u.test(normalized) ||
      normalized.endsWith("/fakeHost.ts")
    ) {
      return {};
    }
    const match = /\/apps\/mac\/ui\/([^/]+)\/(.+)$/u.exec(normalized);
    if (!match) return {};
    const fromLayer = match[1];
    const rest = match[2];
    if (fromLayer === undefined || rest === undefined || !uiLayers.has(fromLayer)) return {};
    const allowed = allowedUiImports[fromLayer];
    if (!allowed) return {};

    const checkSpec = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const out = `${fromLayer}/${rest}`.split("/").slice(0, -1);
      for (const part of spec.split("/")) {
        if (part === "..") {
          if (out.length === 0) return;
          out.pop();
        } else if (part !== ".") {
          out.push(part);
        }
      }
      const targetLayer = out[0] ?? "";
      if (uiLayers.has(targetLayer) && !allowed.has(targetLayer)) {
        context.report({ node, messageId: "layer", data: { from: fromLayer, to: targetLayer } });
      }
    };

    return {
      ImportDeclaration: (node) => checkSpec(node.source, node.source.value),
      ExportNamedDeclaration: (node) => (node.source ? checkSpec(node.source, node.source.value) : undefined),
      ExportAllDeclaration: (node) => checkSpec(node.source, node.source.value),
      ImportExpression: (node) => (node.source.type === "Literal" ? checkSpec(node.source, node.source.value) : undefined),
    };
  },
});

const noComponentInterval = defineRule({
  meta: {
    messages: {
      interval: says(
        "calling `setInterval` directly inside a component creates an unpooled timer per mounted instance",
        "pool shared clocks through `useNow(ms)` (`apps/mac/ui/infra/base/dom.tsx`) or `useInterval` (`apps/mac/ui/infra/base/timer.ts`)",
        "apps/mac/ui/infra/base/dom.tsx",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (clockCall(node.callee, context) === "setInterval") context.report({ node, messageId: "interval" });
      },
    };
  },
});

type AstNode = ESTree.Node;
type FnNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const isFunctionNode = (node: AstNode): node is FnNode =>
  node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function unwrapTypeExpr(node: AstNode | null | undefined): AstNode | null | undefined {
  let cur = node;
  while (cur && (cur.type === "TSAsExpression" || cur.type === "TSSatisfiesExpression" || cur.type === "TSNonNullExpression")) {
    cur = cur.expression;
  }
  return cur;
}

/** True when an expression directly evaluates to JSX (including through nested conditionals or logical chains). */
function producesJsx(node: AstNode | null | undefined): boolean {
  const cur = unwrapTypeExpr(node);
  if (!cur) return false;
  if (cur.type === "JSXElement" || cur.type === "JSXFragment") return true;
  if (cur.type === "ConditionalExpression") return producesJsx(cur.consequent) || producesJsx(cur.alternate);
  if (cur.type === "LogicalExpression") return producesJsx(cur.left) || producesJsx(cur.right);
  return false;
}

const astSkipKeys = new Set(["parent", "loc", "range", "tokens", "comments", "typeAnnotation", "returnType", "typeParameters"]);

/** Walks AST descendants inside the current function scope without descending into nested functions. Return false to skip children. */
function visitSameFunction(root: AstNode | null | undefined, visitor: (node: AstNode) => boolean): void {
  if (!root) return;
  const walk = (node: AstNode): void => {
    if (!visitor(node)) return;
    const entries: [string, unknown][] = Object.entries(node);
    for (const [key, value] of entries) {
      if (astSkipKeys.has(key) || value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isAstNode(item) && !isFunctionNode(item)) walk(item);
        }
      } else if (isAstNode(value) && !isFunctionNode(value)) {
        walk(value);
      }
    }
  };
  walk(root);
}

function functionReturnsJsx(fn: FnNode): boolean {
  if (!fn.body) return false;
  if (fn.body.type !== "BlockStatement") return producesJsx(fn.body);
  let found = false;
  visitSameFunction(fn.body, (node) => {
    if (found) return false;
    if (node.type === "ReturnStatement" && producesJsx(node.argument)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/u.test(name);
}

function componentNameOf(fn: FnNode): string | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id?.name;
  const parent = fn.parent;
  if (parent.type === "VariableDeclarator" && parent.init === fn && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  return undefined;
}

function isJsxComponentFn(fn: FnNode): boolean {
  const name = componentNameOf(fn);
  return name !== undefined && isPascalCase(name) && functionReturnsJsx(fn);
}

function isUntrackedCall(node: AstNode): boolean {
  return node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "untracked";
}

const nshNoJsxConditional = defineRule({
  meta: {
    messages: {
      conditional: says(
        "raw JS ternaries and logical expressions producing JSX compile to dynamic `insert` slots in nsh and remount subtrees on every reactive update (and break inside `<If else={...}>`)",
        "use `<If when={...} else={...}>...</If>` instead (nesting `<If>` inside `else` for multi-branch UI)",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    const check = (node: ESTree.ConditionalExpression | ESTree.LogicalExpression) => {
      if (!producesJsx(node)) return;
      const parent = node.parent;
      if ((parent.type === "ConditionalExpression" || parent.type === "LogicalExpression") && producesJsx(parent)) {
        return;
      }
      context.report({ node, messageId: "conditional" });
    };
    return {
      ConditionalExpression: check,
      LogicalExpression: check,
    };
  },
});

const nshNoJsxMap = defineRule({
  meta: {
    messages: {
      map: says(
        "`.map()` / `.flatMap()` returning JSX rebuilds every item's component tree whenever the list updates instead of reconciling by key",
        "use `<Each of={list} key={(item) => item.id}>{(item) => ...}</Each>` or `<List each={list} keyExtractor={(item) => item.id}>`",
        "docs/style/nsh-tsx.md",
      ),
      iife: says(
        "an IIFE returning JSX inside `{...}` compiles to a dynamic `insert` slot that recreates its subtree on every reactive tick",
        "extract a small component or use `<If>` / `<Each>`",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          (node.callee.property.name === "map" || node.callee.property.name === "flatMap")
        ) {
          const cb = node.arguments[0];
          if (cb && isFunctionNode(cb) && functionReturnsJsx(cb)) {
            context.report({ node, messageId: "map" });
          }
          return;
        }
        if (isFunctionNode(node.callee) && node.parent.type === "JSXExpressionContainer" && functionReturnsJsx(node.callee)) {
          context.report({ node, messageId: "iife" });
        }
      },
    };
  },
});

const nshEachKey = defineRule({
  meta: {
    messages: {
      missingKey: says(
        "`<Each>` without an explicit `key` defaults to JS object pointer identity, unmounting and remounting every row whenever a new slice or array arrives",
        'pass a stable `key={(item) => item.id}` (or `key="index"` only for static positional lists)',
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Each") return;
        const keyAttr = node.attributes.find((attr) => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === "key");
        if (!keyAttr) {
          context.report({ node, messageId: "missingKey" });
          return;
        }
        if (
          keyAttr.type === "JSXAttribute" &&
          keyAttr.value?.type === "JSXExpressionContainer" &&
          keyAttr.value.expression.type === "Identifier" &&
          keyAttr.value.expression.name === "undefined"
        ) {
          context.report({ node: keyAttr, messageId: "missingKey" });
        }
      },
    };
  },
});

const nshNoPropsDestructure = defineRule({
  meta: {
    messages: {
      param: says(
        "destructuring `props` in a component parameter reads every property eagerly once and breaks nsh getter reactivity",
        "accept `props` as a single parameter and read `props.x` inside JSX or closures (or use `split(props, [...])` from `nsh`)",
        "docs/style/nsh-tsx.md",
      ),
      body: says(
        "destructuring `props` at the top level of a component reads every property eagerly once and breaks nsh getter reactivity",
        "read `props.x` inside JSX, `computed()`, or closures (or use `split(props, [...])` from `nsh`; wrap one-time snapshots in `untracked(() => props.x)`)",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    const checkFn = (fn: FnNode) => {
      if (!isJsxComponentFn(fn)) return;
      const first = fn.params[0];
      if (first === undefined) return;
      const param = first.type === "AssignmentPattern" ? first.left : first;
      if (param.type === "ObjectPattern") {
        context.report({ node: param, messageId: "param" });
        return;
      }
      if (param.type !== "Identifier" || fn.body?.type !== "BlockStatement") return;
      const propsName = param.name;
      visitSameFunction(fn.body, (node) => {
        if (isUntrackedCall(node) || node.type === "JSXElement" || node.type === "JSXFragment") return false;
        if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
          const init = unwrapTypeExpr(node.init);
          if (init?.type === "Identifier" && init.name === propsName) {
            context.report({ node, messageId: "body" });
          }
        }
        return true;
      });
    };
    return {
      FunctionDeclaration: checkFn,
      FunctionExpression: checkFn,
      ArrowFunctionExpression: checkFn,
    };
  },
});

const reactiveCreatorNames = new Set(["signal", "computed", "createSignal", "createMemo", "frame"]);

function collectLocalReactiveAccessors(body: ESTree.BlockStatement): Set<string> {
  const names = new Set<string>();
  for (const stmt of body.body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) {
      const init = unwrapTypeExpr(decl.init);
      if (!init || init.type !== "CallExpression" || init.callee.type !== "Identifier") continue;
      const callee = init.callee.name;
      if (!reactiveCreatorNames.has(callee)) continue;
      if (callee === "createSignal" && decl.id.type === "ArrayPattern" && decl.id.elements[0]?.type === "Identifier") {
        names.add(decl.id.elements[0].name);
      } else if (decl.id.type === "Identifier") {
        names.add(decl.id.name);
      }
    }
  }
  return names;
}

function readsPropsDirectly(node: AstNode | null | undefined, propsName: string): boolean {
  const cur = unwrapTypeExpr(node);
  if (!cur) return false;
  if (cur.type === "ChainExpression") return readsPropsDirectly(cur.expression, propsName);
  if (cur.type === "MemberExpression") {
    if (cur.object.type === "Identifier" && cur.object.name === propsName) return true;
    return readsPropsDirectly(cur.object, propsName);
  }
  if (cur.type === "UnaryExpression") return readsPropsDirectly(cur.argument, propsName);
  if (cur.type === "BinaryExpression" || cur.type === "LogicalExpression") {
    return readsPropsDirectly(cur.left, propsName) || readsPropsDirectly(cur.right, propsName);
  }
  if (cur.type === "ConditionalExpression") {
    return readsPropsDirectly(cur.test, propsName) || readsPropsDirectly(cur.consequent, propsName) || readsPropsDirectly(cur.alternate, propsName);
  }
  if (cur.type === "TemplateLiteral") return cur.expressions.some((expr) => readsPropsDirectly(expr, propsName));
  return false;
}

function readsAccessorDirectly(node: AstNode | null | undefined, accessors: ReadonlySet<string>): boolean {
  const cur = unwrapTypeExpr(node);
  if (!cur) return false;
  if (cur.type === "ChainExpression") return readsAccessorDirectly(cur.expression, accessors);
  if (cur.type === "CallExpression") {
    return cur.callee.type === "Identifier" && accessors.has(cur.callee.name) && cur.arguments.length === 0;
  }
  if (cur.type === "MemberExpression") return readsAccessorDirectly(cur.object, accessors);
  if (cur.type === "UnaryExpression") return readsAccessorDirectly(cur.argument, accessors);
  if (cur.type === "BinaryExpression" || cur.type === "LogicalExpression") {
    return readsAccessorDirectly(cur.left, accessors) || readsAccessorDirectly(cur.right, accessors);
  }
  if (cur.type === "ConditionalExpression") {
    return readsAccessorDirectly(cur.test, accessors) || readsAccessorDirectly(cur.consequent, accessors) || readsAccessorDirectly(cur.alternate, accessors);
  }
  if (cur.type === "TemplateLiteral") return cur.expressions.some((expr) => readsAccessorDirectly(expr, accessors));
  return false;
}

const nshNoEagerAccessor = defineRule({
  meta: {
    messages: {
      callbackAccessor: says(
        "calling `<If>`/`<Each>` accessor `{{name}}()` at the top level of its render callback reads it once and freezes subsequent updates",
        "read `{{name}}()` inside JSX, a `computed()`, or a helper arrow function (or pass `{{name}}` as an accessor `() => T`)",
        "docs/style/nsh-tsx.md",
      ),
      componentRead: says(
        "reading reactive `props` or signals eagerly at component top level runs once during mount and will not update when inputs change",
        "wrap derived values in `() => ...` or `computed(() => ...)`, use `<If>` for conditional UI, or wrap intentional one-time snapshots in `untracked(() => ...)`",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    const checkComponent = (fn: FnNode) => {
      if (!isJsxComponentFn(fn) || fn.body?.type !== "BlockStatement") return;
      const first = fn.params[0];
      const propsName = first?.type === "Identifier" ? first.name : undefined;
      const accessors = collectLocalReactiveAccessors(fn.body);
      if (propsName === undefined && accessors.size === 0) return;

      visitSameFunction(fn.body, (node) => {
        if (isUntrackedCall(node) || node.type === "JSXElement" || node.type === "JSXFragment") return false;
        if (node.type === "VariableDeclarator" && node.init) {
          if ((propsName !== undefined && readsPropsDirectly(node.init, propsName)) || (accessors.size > 0 && readsAccessorDirectly(node.init, accessors))) {
            context.report({ node, messageId: "componentRead" });
            return false;
          }
        }
        if (node.type === "IfStatement" || node.type === "SwitchStatement") {
          const test = node.type === "IfStatement" ? node.test : node.discriminant;
          if ((propsName !== undefined && readsPropsDirectly(test, propsName)) || (accessors.size > 0 && readsAccessorDirectly(test, accessors))) {
            context.report({ node: test, messageId: "componentRead" });
          }
        }
        return true;
      });
    };

    const checkControlFlowChild = (node: ESTree.JSXElement) => {
      if (node.openingElement.name.type !== "JSXIdentifier") return;
      const tag = node.openingElement.name.name;
      if (tag !== "If" && tag !== "Each") return;
      for (const child of node.children) {
        if (child.type !== "JSXExpressionContainer") continue;
        const expr = child.expression;
        if (!isFunctionNode(expr) || !expr.body) continue;
        const paramNames = new Set<string>();
        for (const p of expr.params) {
          if (p.type === "Identifier") paramNames.add(p.name);
        }
        if (paramNames.size === 0) continue;
        visitSameFunction(expr.body, (inner) => {
          if (isUntrackedCall(inner) || inner.type === "JSXElement" || inner.type === "JSXFragment") return false;
          if (inner.type === "CallExpression" && inner.callee.type === "Identifier" && paramNames.has(inner.callee.name) && inner.arguments.length === 0) {
            context.report({ node: inner, messageId: "callbackAccessor", data: { name: inner.callee.name } });
            return false;
          }
          return true;
        });
      }
    };

    return {
      FunctionDeclaration: checkComponent,
      FunctionExpression: checkComponent,
      ArrowFunctionExpression: checkComponent,
      JSXElement: checkControlFlowChild,
    };
  },
});

const highFreqEventProps = new Set(["onChange", "onInput", "onSelectionChange", "onPanResponderMove", "onScroll", "onScrollBeginDrag"]);

function memberPropertyName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return undefined;
}

function storageWriteTarget(calleeNode: AstNode): "localStorage" | "Storage" | undefined {
  const cur = unwrapTypeExpr(calleeNode);
  const callee = cur?.type === "ChainExpression" ? unwrapTypeExpr(cur.expression) : cur;
  if (!callee || callee.type !== "MemberExpression") return undefined;
  if (memberPropertyName(callee) !== "setItem") return undefined;
  const obj = unwrapTypeExpr(callee.object);
  if (!obj) return undefined;
  if (obj.type === "Identifier") {
    if (obj.name === "localStorage" || obj.name === "Storage") return obj.name;
    return undefined;
  }
  if (obj.type === "MemberExpression" && memberPropertyName(obj) === "localStorage" && obj.object.type === "Identifier" && globals.has(obj.object.name)) {
    return "localStorage";
  }
  return undefined;
}

function collectHandlerFns(expr: AstNode | null | undefined, out: FnNode[]): void {
  const cur = unwrapTypeExpr(expr);
  if (!cur) return;
  if (isFunctionNode(cur)) {
    out.push(cur);
    return;
  }
  if (cur.type === "ConditionalExpression") {
    collectHandlerFns(cur.consequent, out);
    collectHandlerFns(cur.alternate, out);
  } else if (cur.type === "LogicalExpression") {
    collectHandlerFns(cur.left, out);
    collectHandlerFns(cur.right, out);
  }
}

const nshNoDirectStorageInEvent = defineRule({
  meta: {
    messages: {
      directWrite: says(
        "calling `{{target}}.setItem()` directly inside high-frequency `{{event}}` handlers causes per-frame JSON serialization and synchronous storage I/O jank",
        "route writes through a debounced buffer or `defineStored` with an equality guard",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const event = node.name.name;
        if (!highFreqEventProps.has(event) || node.value?.type !== "JSXExpressionContainer") return;
        const handlers: FnNode[] = [];
        collectHandlerFns(node.value.expression, handlers);
        for (const fn of handlers) {
          visitSameFunction(fn.body, (inner) => {
            if (inner.type === "CallExpression") {
              const target = storageWriteTarget(inner.callee);
              if (target !== undefined) context.report({ node: inner, messageId: "directWrite", data: { target, event } });
            }
            return true;
          });
        }
      },
    };
  },
});

function isKeymapBindCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = unwrapTypeExpr(node.callee);
  if (!callee || callee.type !== "MemberExpression") return false;
  const obj = unwrapTypeExpr(callee.object);
  return obj?.type === "Identifier" && obj.name === "keymap" && memberPropertyName(callee) === "bind";
}

function isStringLiteralNode(node: AstNode | null | undefined): boolean {
  const cur = unwrapTypeExpr(node);
  if (!cur) return false;
  if (cur.type === "Literal") return typeof cur.value === "string";
  return cur.type === "TemplateLiteral" && cur.expressions.length === 0;
}

function isZeroArgCall(node: AstNode | null | undefined): boolean {
  const cur = unwrapTypeExpr(node);
  if (!cur) return false;
  if (cur.type === "ChainExpression") return isZeroArgCall(cur.expression);
  return cur.type === "CallExpression" && cur.arguments.length === 0;
}

const nshKeymapNoTextSignal = defineRule({
  meta: {
    messages: {
      textSignal: says(
        "reading a live text signal directly inside a keymap `effect` tears down and re-registers native GPUI keymaps on every keystroke",
        "lift the predicate into `const isEmpty = computed(() => ...)` outside `effect()`",
        "docs/style/nsh-tsx.md",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "effect") return;
        const cb = node.arguments[0];
        if (!cb || !isFunctionNode(cb) || !cb.body) return;
        let hasKeymapBind = false;
        const comparisons: ESTree.BinaryExpression[] = [];
        visitSameFunction(cb.body, (inner) => {
          if (isKeymapBindCall(inner)) hasKeymapBind = true;
          if (
            inner.type === "BinaryExpression" &&
            (inner.operator === "===" || inner.operator === "!==") &&
            ((isZeroArgCall(inner.left) && isStringLiteralNode(inner.right)) || (isStringLiteralNode(inner.left) && isZeroArgCall(inner.right)))
          ) {
            comparisons.push(inner);
          }
          return true;
        });
        if (!hasKeymapBind) return;
        for (const cmp of comparisons) {
          context.report({ node: cmp, messageId: "textSignal" });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "vibevalley" },
  rules: {
    "no-test-sleep": noTestSleep,
    "no-component-interval": noComponentInterval,
    "no-comment-divider": noCommentDivider,
    "no-cjk-literal": noCjkLiteral,
    "style-attrs": styleAttrs,
    "subpackage-layers": subpackageLayersRule,
    "ui-layer-boundaries": uiLayerBoundaries,
    "no-cross-package-path": noCrossPackagePath,
    "child-process-door": childProcessDoor,
    "one-absent": oneAbsent,
    "global-doors": globalDoors,
    "nsh-no-jsx-conditional": nshNoJsxConditional,
    "nsh-no-jsx-map": nshNoJsxMap,
    "nsh-each-key": nshEachKey,
    "nsh-no-props-destructure": nshNoPropsDestructure,
    "nsh-no-eager-accessor": nshNoEagerAccessor,
    "nsh-no-direct-storage-in-event": nshNoDirectStorageInEvent,
    "nsh-keymap-no-text-signal": nshKeymapNoTextSignal,
  },
});
