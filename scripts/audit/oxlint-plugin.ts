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
        "apps/mac/ui/vv/app/app.test.tsx",
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
  if (/\/apps\/mac\/ui\/surfaces\//u.test(normalized)) return "web.shell";
  const rest = /\/apps\/mac\/ui\/vv\/web\/(.*)$/u.exec(normalized)?.[1];
  if (rest === undefined) return "shared";
  const folders = rest
    .split("/")
    .slice(0, -1)
    .filter((f) => f !== "features");
  for (let n = folders.length; n > 0; n--) {
    const name = ["web", ...folders.slice(0, n)].join(".");
    if (existsSync(resolve(repo, "crates/vibevalley-i18n/locales/zh", `${name}.json`))) return name;
  }
  return "web";
}

const noCjkLiteral = defineRule({
  meta: {
    messages: {
      cjk: says(
        "words written in code are not translated: an English farm would show them in Chinese",
        'add a key to crates/vibevalley-i18n/locales/zh/{{catalog}}.json and en/{{catalog}}.json, run `vp run i18n:gen`, and write `t("{{catalog}}.<key>")`',
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

export default definePlugin({
  meta: { name: "vibevalley" },
  rules: {
    "no-test-sleep": noTestSleep,
    "no-comment-divider": noCommentDivider,
    "no-cjk-literal": noCjkLiteral,
    "style-attrs": styleAttrs,
    "subpackage-layers": subpackageLayersRule,
    "no-cross-package-path": noCrossPackagePath,
    "child-process-door": childProcessDoor,
    "one-absent": oneAbsent,
    "global-doors": globalDoors,
  },
});
