import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { definePlugin, defineRule, type ESTree, type Context, type Scope } from "vite-plus/lint/plugins";

import { classAdvice, hexColor, offClassTokens, offTokens, tokenAdvice, type ClassKind, type TokenKind } from "./design-tokens.ts";

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

const noWallClock = defineRule({
  meta: {
    messages: {
      wallClock: says(
        "this reads or waits on the wall clock, which a test's clock cannot move",
        "read and wait through the clock the module was handed: `deps.clock.now()`, `await deps.clock.sleep(ms, signal)`, `withTimeout(…, { clock })` (@vibevalley/async); only infra/time.ts touches the real one",
        "apps/server/src/infra/time.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = clockCall(node.callee, context);
        if (name === "Date.now" || timerCalls.has(name ?? "")) context.report({ node, messageId: "wallClock" });
      },
      NewExpression(node) {
        if (clockCall(node.callee, context) === "Date" && node.arguments.length === 0) context.report({ node, messageId: "wallClock" });
      },
    };
  },
});

const noTestSleep = defineRule({
  meta: {
    messages: {
      sleep: says(
        "a test that waits a set time guesses how long the work takes: slow when it is quick, flaky when it is slow",
        "wait for the thing itself: `until(() => …)`, `untilGot`, `waitFor` or `whenState` for work in the background, `vi.advanceTimersByTimeAsync(ms)` under fake timers or a test clock through a window, `gate()` to hold a fake until the test lets it go, `aTurn` before checking nothing happened",
        "packages/testkit/src/until.ts",
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
        for (const comment of context.sourceCode.getAllComments())
          if (/[─━═]{2}/u.test(comment.value) || /^[-=*#~_/\s]{4,}$/u.test(comment.value.trim())) context.report({ loc: comment.loc, messageId: "divider" });
      },
    };
  },
});

const textArg = new Set(["getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByAltText", "toHaveText", "toContainText"]);

/** Options that name the words: getByRole's name, filter's and locator's hasText. */
const textOption = new Set(["name", "hasText", "hasNotText"]);

type ObjectProperty = { type: string; key?: { type: string; name?: string }; value?: Parameters<typeof chineseLiteral>[0] };

const chineseLiteral = (node: { type: string; value?: unknown; regex?: { pattern: string }; quasis?: { value: { raw: string } }[] } | undefined) =>
  !!node &&
  ((node.type === "Literal" && typeof node.value === "string" && han.test(node.value)) ||
    (node.type === "Literal" && node.regex !== undefined && han.test(node.regex.pattern)) ||
    (node.type === "TemplateLiteral" && (node.quasis ?? []).some((q) => han.test(q.value.raw))));

const noCopySelector = defineRule({
  meta: {
    messages: {
      copy: says(
        "a page test that finds or checks the interface's words breaks on every rewording; the words are the catalogs' to check",
        'find it by `getByTestId("…")` or a state attribute (`[data-state=…]`) and add the data-testid to the component if it has none; data the test made itself goes in a constant in fixtures.ts',
        "apps/web/test/fixtures.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "MemberExpression" || c.property.type !== "Identifier") return;
        const name = c.property.name;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
        const [first] = node.arguments as unknown as Parameters<typeof chineseLiteral>[0][];
        if (textArg.has(name) && chineseLiteral(first)) context.report({ node, messageId: "copy" });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
        for (const arg of node.arguments as unknown as { type: string; properties?: ObjectProperty[] }[])
          if (arg.type === "ObjectExpression")
            for (const p of arg.properties ?? [])
              if (p.type === "Property" && p.key?.type === "Identifier" && textOption.has(p.key.name ?? "") && chineseLiteral(p.value))
                context.report({ node, messageId: "copy" });
      },
    };
  },
});

function styleKey(node: ESTree.Node): string | undefined {
  return node.type === "Identifier" ? node.name : node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function jsxStyleValues(
  node: ESTree.Node,
  property: string | undefined,
  inspect: (item: { node: ESTree.Node; property: string | undefined; value: string }) => void,
) {
  switch (node.type) {
    case "ObjectExpression":
      for (const entry of node.properties) {
        if (entry.type === "Property") jsxStyleValues(entry.value, styleKey(entry.key) ?? property, inspect);
      }
      break;
    case "ConditionalExpression":
      jsxStyleValues(node.consequent, property, inspect);
      jsxStyleValues(node.alternate, property, inspect);
      break;
    case "LogicalExpression":
      jsxStyleValues(node.left, property, inspect);
      jsxStyleValues(node.right, property, inspect);
      break;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      jsxStyleValues(node.expression, property, inspect);
      break;
    case "Literal":
      if (typeof node.value === "string") inspect({ node, property, value: node.value });
      break;
    case "TemplateLiteral":
      inspect({ node, property, value: node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("${}") });
      for (const expression of node.expressions) jsxStyleValues(expression, property, inspect);
      break;
    default:
      break;
  }
}

/** Every string in the file read as Tailwind reads it, as possible classes (scripts/audit/design-tokens.ts, offClassTokens). */
function classStrings(inspect: (node: ESTree.Node, found: { token: string; kind: ClassKind }) => void) {
  return {
    Literal(node: ESTree.StringLiteral | ESTree.Node) {
      if (node.type === "Literal" && typeof node.value === "string") for (const found of offClassTokens(node.value)) inspect(node, found);
    },
    TemplateLiteral(node: ESTree.TemplateLiteral) {
      for (const quasi of node.quasis) for (const found of offClassTokens(quasi.value.cooked ?? quasi.value.raw)) inspect(node, found);
    },
  };
}

const noHexColor = defineRule({
  meta: {
    messages: {
      hex: says(
        "a colour written into a style stays as it is when the theme changes (设置 › 外观)",
        "use a host palette reference such as var(--color-ok-soft) or var(--color-ink); a new purpose gets a name in style.css, in both themes",
        "apps/web/src/style.css",
      ),
      hexClass: says(
        "`{{token}}` writes a colour into a class, and it stays as it is when the theme changes (设置 › 外观)",
        `use ${classAdvice.hex}`,
        "apps/web/src/style.css",
      ),
    },
  },
  create(context) {
    const check = ({ node, property, value }: { node: ESTree.Node; property: string | undefined; value: string | number }) => {
      if (typeof value === "string" && hexColor(property, value)) context.report({ node, messageId: "hex" });
    };
    return {
      ...classStrings((node, { token, kind }) => {
        if (kind === "hex") context.report({ node, messageId: "hexClass", data: { token } });
      }),
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "style" || node.value?.type !== "JSXExpressionContainer") return;
        jsxStyleValues(node.value.expression, undefined, check);
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

const styleAttrs = defineRule({
  meta: {
    messages: {
      classAttr: says(
        "`{{attr}}` is not how Solid 2 takes classes, so the element gets none",
        "write `class`: a string, an array or `cx(...)` from ui/cx.ts (Tailwind utilities, vv-tailwind)",
        "apps/web/src/ui/cx.ts",
      ),
      fixedStyle: says(
        "a `style` with only written-out values is a class that skips the tokens and the lint on them",
        "write the Tailwind utilities in `class` (vv-tailwind); `style` is for a value worked out at run time, such as a width in percent",
        "apps/web/src/ui/cx.ts",
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
        const element = node.parent.type === "JSXOpeningElement" && node.parent.name.type === "JSXIdentifier" && /^[a-z]/u.test(node.parent.name.name);
        if (attr !== "style" || node.value === null || !element) return;
        const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (fixedStyle(value)) context.report({ node, messageId: "fixedStyle" });
      },
    };
  },
});

const designTokens = defineRule({
  meta: {
    messages: {
      ...Object.fromEntries(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tokenAdvice has one key per TokenKind and no more
        (Object.keys(tokenAdvice) as TokenKind[]).map((kind) => [
          kind,
          says(`this ${kind} is off the workbench's ladder, so it matches nothing beside it`, `use ${tokenAdvice[kind]}`, "docs/style/design.md"),
        ]),
      ),
      ...Object.fromEntries(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- classAdvice has one key per ClassKind and no more
        (Object.keys(classAdvice) as ClassKind[])
          .filter((kind) => kind !== "hex")
          .map((kind) => [
            `${kind}Class`,
            says(
              `\`{{token}}\` puts a ${kind} off the workbench's ladder into a class, so it matches nothing beside it`,
              `use ${classAdvice[kind]}`,
              ".agents/skills/vv-tailwind/SKILL.md",
            ),
          ]),
      ),
    },
  },
  create(context) {
    return {
      ...classStrings((node, { token, kind }) => {
        if (kind !== "hex") context.report({ node, messageId: `${kind}Class`, data: { token } });
      }),
      // A value worked out at run time goes in `style`; one written out there is held to the same ladders.
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "style" || node.value?.type !== "JSXExpressionContainer") return;
        jsxStyleValues(node.value.expression, undefined, ({ node: value, property, value: text }) => {
          if (property === undefined || text.includes("${}")) return;
          const kind = offTokens(
            property.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase()),
            text,
          );
          if (kind) context.report({ node: value, messageId: kind });
        });
      },
    };
  },
});

// Chinese punctuation too: a word joined to its neighbor with 「：」 or 「、」 in code reads as Chinese in an English farm.
const han = /[\p{Script=Han}、，。：；（）！？「」【】〔〕]/u;

/** The catalog a file's words belong in. */
export function catalogOf(filename: string): string {
  const at = /\/apps\/(server|web|desktop|mobile|cli)\/(?:src\/)?(.*)$/u.exec(filename.replaceAll("\\", "/"));
  const host = at?.[1];
  const rest = at?.[2];
  if (host === undefined || rest === undefined) return "shared";
  const folders = rest
    .split("/")
    .slice(0, -1)
    .filter((f) => f !== "features" && f !== "platform" && f !== "modules" && f !== "gateway");
  for (let n = folders.length; n > 0; n--) {
    const name = [host, ...folders.slice(0, n)].join(".");
    if (existsSync(resolve(repo, "packages/i18n/locales/zh", `${name}.json`))) return name;
  }
  return host;
}

const noCjkLiteral = defineRule({
  meta: {
    messages: {
      cjk: says(
        "words written in code are not translated: an English farm would show them in Chinese",
        'for the owner, add a key to packages/i18n/locales/zh/{{catalog}}.json and en/{{catalog}}.json, run `vp run i18n:gen`, and write `t("{{catalog}}.<key>")`; for a model, put it in this module\'s prompts.ts',
        "packages/i18n/README.md",
      ),
    },
  },
  create(context) {
    const data = { catalog: catalogOf(context.filename) };
    return {
      // Read as written: a character spelled as a \u escape is a code point on purpose (a keystroke an input method
      // types, base/typedMarks.ts), not words.
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

const nativeTypes = new Set(["checkbox", "radio", "range"]);

const nativeControl = defineRule({
  meta: {
    messages: {
      native: says(
        "a native chooser is drawn by the system: it looks different on every machine and stays light in the dark theme",
        "`Select` from ui/Field.tsx for a <select>, ui/Checkbox.tsx for a checkbox, base-ui's `RadioGroup` and `Slider` for radio and range",
        "apps/web/src/ui/Field.tsx",
      ),
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        const type = node.attributes.find((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "type");
        const value = type?.type === "JSXAttribute" && type.value?.type === "Literal" ? type.value.value : undefined;
        if (tag === "select" || (tag === "input" && typeof value === "string" && nativeTypes.has(value))) context.report({ node, messageId: "native" });
      },
    };
  },
});

// The page's layers, in order; a file may import from its own unit or one before it.
const pageLayers = ["base", "infra", "state", "ui", "ui/domain", "ui/pixel", "features", "skin", "app", "root"] as const;

function pageUnit(path: string): { layer: (typeof pageLayers)[number]; unit: string } {
  const parts = path.split("/");
  if (parts.length === 1) return { layer: "root", unit: "" };
  if (parts[0] === "ui" && parts[1] === "domain" && parts.length > 2) return { layer: "ui/domain", unit: "ui/domain" };
  if (parts[0] === "ui" && parts[1] === "pixel" && parts.length > 2) return { layer: "ui/pixel", unit: "ui/pixel" };
  if (parts[0] === "features") return { layer: "features", unit: `features/${parts[1]}` };
  if (parts[0] === "farm" || parts[0] === "tree") return { layer: "skin", unit: parts[0] };
  const layer = pageLayers.find((l) => l === parts[0]);
  return { layer: layer ?? "root", unit: parts[0]! };
}

/** Both paths are relative to the page's src. */
function joinPath(from: string, spec: string) {
  const out = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}

const pageLayersRule = defineRule({
  meta: {
    messages: {
      layer: says(
        "{{from}} is before {{to}} in the page's layers (base, infra, state, ui, ui/domain, ui/pixel, features, farm and tree, app), and a layer imports only its own and those before it",
        "move what both need down into a layer before {{from}} (a pure function to base, a talk with the outside to infra, a component to ui), or have {{to}} pass it in as a prop",
        "apps/web/README.md",
      ),
      index: says(
        "a file inside another feature is its own business, free to change",
        'import it from its index ("#/{{unit}}/index.ts"), and export it there if it is meant to be shared',
        "apps/web/README.md",
      ),
      sibling: says(
        "one feature does not import another's files, nor a skin another skin's: each is its own unit",
        "move what both need down into base or ui",
        "apps/web/README.md",
      ),
    },
  },
  create(context) {
    const at = context.filename.replaceAll("\\", "/").split("/apps/web/src/")[1];
    if (at === undefined) return {};
    const from = pageUnit(at);
    type Verdict = { messageId: "layer" | "index" | "sibling"; data: Record<string, string> };
    const verdict = (spec: unknown): Verdict | undefined => {
      if (typeof spec !== "string" || !(spec.startsWith(".") || spec.startsWith("#/"))) return;
      // A file is the same unit whether or not its import names its extension.
      const target = (spec.startsWith("#/") ? spec.slice(2) : joinPath(at, spec)).replace(/\.tsx?$/u, "");
      if (target.startsWith("..")) return;
      const to = pageUnit(target);
      if (to.unit === from.unit) return;
      const a = pageLayers.indexOf(from.layer);
      const b = pageLayers.indexOf(to.layer);
      const data = { from: from.unit || "the page's root", to: to.unit || "the page's root", unit: to.unit };
      if (b > a) return { messageId: "layer", data };
      if (b === a && from.layer !== "features") return { messageId: "sibling", data };
      if (to.layer === "features" && target !== to.unit && target !== `${to.unit}/index`) return { messageId: "index", data };
      return undefined;
    };
    const check = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      const v = verdict(spec);
      if (v) context.report({ node, ...v });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
    };
  },
});

const functionTypes = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

/** The function an await belongs to (the nearest one around it), whether it is async, and what it is passed to. */
function ownerOf(node: { parent?: unknown }): { fn: object; async: boolean; parent: unknown } | undefined {
  let at: unknown = node.parent;
  while (typeof at === "object" && at !== null) {
    const parent = "parent" in at ? at.parent : undefined;
    if ("type" in at && typeof at.type === "string" && functionTypes.has(at.type)) return { fn: at, async: "async" in at && at.async === true, parent };
    at = parent;
  }
  return undefined;
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

const dbDrivers = new Set(["pg", "@electric-sql/pglite"]);
const isDbDriver = (spec: string) => [...dbDrivers].some((d) => spec === d || spec.startsWith(`${d}/`));

const dbDoor = defineRule({
  meta: {
    messages: {
      driver: says(
        "`{{source}}` is the database's driver: a module that opens or queries it by hand bypasses Db, its transactions, its afterCommit hooks and the query count, and decides again what a failed statement becomes",
        "take `db: Db` from the module's deps and call the generated query with it (`getIssue(db.sql, …)`, `await db.tx(async () => …)`); only `apps/server/src/infra/db.ts` imports the driver",
        "apps/server/src/infra/db.ts",
      ),
    },
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("apps/server/src/infra/db.ts")) return {};
    const check = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec === "string" && isDbDriver(spec)) context.report({ node, messageId: "driver", data: { source: spec } });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => (node.source.type === "Literal" ? check(node, node.source.value) : undefined),
    };
  },
});

const syncFs = defineRule({
  meta: {
    messages: {
      sync: says(
        "{{name}} holds the event loop while it reads or writes, so every helper's stream and every request waits on the disk",
        "`await` node:fs/promises (`readFile`, `writeFile`, `rename`, `readdir`…); a file the server keeps is a `keptFile` (infra/files.ts)",
        "apps/server/src/infra/files.ts",
      ),
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "node:fs" && node.source.value !== "fs") return;
        for (const s of node.specifiers)
          if (s.type === "ImportSpecifier" && s.imported.type === "Identifier" && s.imported.name.endsWith("Sync"))
            context.report({ node: s, messageId: "sync", data: { name: s.imported.name } });
      },
    };
  },
});

const droppedTimer = defineRule({
  meta: {
    messages: {
      dropped: says(
        "a timer whose handle is dropped cannot be cleared, so it still fires after the part that set it is gone",
        "`useTimeout()` or `useInterval(fn, ms)` from `#/base/timer.ts` in a component; in a Solid effect, keep the handle and return `() => clearTimeout(t)`; a store that lives as long as the page keeps the handle too, or says why it need not with a disable comment",
        "apps/web/src/base/timer.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "Identifier" || (c.name !== "setTimeout" && c.name !== "setInterval")) return;
        if (node.parent.type === "ExpressionStatement") context.report({ node, messageId: "dropped" });
      },
    };
  },
});

const childProcessDoor = defineRule({
  meta: {
    messages: {
      spawn: says(
        "a process started here is one more place that must kill its whole group on a timeout and keep what it printed, which the doors already do",
        "git through `apps/server/src/modules/repo/git.ts` (tests: `gitSync`, `gitIn` in `apps/server/src/testing/git.ts`), a helper's command through `runtime/dsh.ts`; a new kind of process gets its own door, added to the list in vite.config.ts",
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

const solidStores = new Set(["createSignal", "createStore"]);

const pageStore = defineRule({
  meta: {
    messages: {
      store: says(
        "`{{call}}` outside any function is a store of the page's kept by hand: plain code cannot hear it, a test cannot reset it, and it is a second way of keeping what the page keeps in atoms",
        "make it an atom of the page's: `const x = defineAtom(initial)` (state/atom.ts), read `x.get()` (it follows in Solid), write `x.set(v)` or `x.update(f)`; a choice kept on this machine is `defineStored(name, schema, fallback)` (state/stored.ts); a value one component owns is made in that component",
        "apps/web/src/state/atom.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "Identifier" || !solidStores.has(c.name) || ownerOf(node)) return;
        context.report({ node, messageId: "store", data: { call: c.name } });
      },
    };
  },
});

const storages = new Set(["localStorage", "sessionStorage"]);

const storedDoor = defineRule({
  meta: {
    messages: {
      storage: says(
        "`{{name}}` reached by hand: what it reads is not decoded, a storage that throws (a private window, a full one) breaks the page, the key is outside the page's namespace, and no other reader hears the change",
        "keep the choice with `defineStored(name, schema, fallback)` (state/stored.ts) and read and set it like any page value; a struct whose fields fall back one by one uses `orFallback`",
        "apps/web/src/state/stored.ts",
      ),
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    if (file.endsWith("/apps/web/src/state/stored.ts")) return {};
    return {
      Identifier(node) {
        if (!storages.has(node.name)) return;
        const parent = node.parent;
        // User objects can have storage-like property names without accessing browser storage.
        if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
          const owner = parent.object;
          if (!(owner.type === "Identifier" && (owner.name === "window" || owner.name === "globalThis" || owner.name === "self"))) return;
        }
        if (parent?.type === "Property" && parent.key === node && !parent.computed) return;
        context.report({ node, messageId: "storage", data: { name: node.name } });
      },
    };
  },
});

/** The client's methods that only read: everything else changes something on the server. */
const readVerbs = new Set(["list", "get", "search", "recall", "validate"]);

function apiVerb(callee: ESTree.Node): string | undefined {
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return undefined;
  let at: ESTree.Node = callee.object;
  while (at.type === "MemberExpression") at = at.object;
  return at.type === "Identifier" && at.name === "api" ? callee.property.name : undefined;
}

const isActionOf = (call: unknown, fn: object): boolean => {
  if (typeof call !== "object" || call === null || !("type" in call) || call.type !== "CallExpression") return false;
  if (!("arguments" in call) || !Array.isArray(call.arguments) || !call.arguments.includes(fn) || !("callee" in call)) return false;
  const callee = call.callee;
  if (typeof callee !== "object" || callee === null || !("type" in callee) || callee.type !== "MemberExpression" || !("property" in callee)) return false;
  const property = callee.property;
  return typeof property === "object" && property !== null && "name" in property && (property.name === "run" || property.name === "attempt");
};

function insideAction(node: { parent?: unknown }): boolean {
  for (let owner = ownerOf(node); owner; owner = ownerOf(owner.fn)) if (isActionOf(owner.parent, owner.fn)) return true;
  return false;
}

const actDoor = defineRule({
  meta: {
    messages: {
      act: says(
        "`api.{{call}}` changes something on the server straight from a component: it has no busy, no refusal in the error tone, and goes out while the state stream is lost",
        "hand it to an Act (`const act = createAct()` from ui/act.ts, `createPixelAct()` in a skin; `act.run(() => api.{{call}}(…))`, or `act.attempt(…)` for an explicit receipt), or, when the page shows the change before the server has it, send it through an intent defined in the feature's .ts (`defineIntent`, state/intent.ts) with an overlay of its own",
        "apps/web/src/ui/act.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const verb = apiVerb(node.callee);
        if (verb === undefined || readVerbs.has(verb) || verb.startsWith("preview") || insideAction(node)) return;
        context.report({
          node,
          messageId: "act",
          data: {
            call: context.sourceCode
              .getText(node.callee)
              .replaceAll(/\s+/gu, "")
              .replace(/^api\./u, ""),
          },
        });
      },
    };
  },
});

const failureTone = defineRule({
  meta: {
    messages: {
      tone: says(
        "a refusal said in the plain tone reads like news, and the owner misses that it did not happen",
        'give the workbench\'s toast the error tone (`toast(reasonOf(e), "bad")`), the pixel one the error type (`toasts.add({ type: ToastType.error, … })`); or run the call through an Act (ui/act.ts), which says refusals so',
        "apps/web/src/ui/act.ts",
      ),
    },
  },
  create(context) {
    const saysReason = (n: ESTree.Node | undefined) => n !== undefined && /\breasonOf\(/u.test(context.sourceCode.getText(n));
    return {
      CallExpression(node) {
        const c = node.callee;
        const [first, second] = node.arguments;
        if (c.type === "Identifier" && c.name === "toast") {
          if (saysReason(first) && !(second?.type === "Literal" && second.value === "bad")) context.report({ node, messageId: "tone" });
          return;
        }
        const pixel =
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "toasts" &&
          c.property.type === "Identifier" &&
          c.property.name === "add";
        if (!pixel || first?.type !== "ObjectExpression" || !saysReason(first)) return;
        const type = first.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "type");
        const error = type?.type === "Property" && /^(?:ToastType\.error|"error")$/u.test(context.sourceCode.getText(type.value));
        if (!error) context.report({ node, messageId: "tone" });
      },
    };
  },
});

/** A subpath import names its file (package.json imports map exactly): the target with the extension it has on disk, or its folder's index. */
function withExtension(filename: string, spec: string, target: string) {
  if (/\.[cm]?[jt]sx?$/u.test(spec)) return target;
  const base = resolve(dirname(filename), spec);
  const found = [".ts", ".tsx", "/index.ts", "/index.tsx"].find((ext) => existsSync(base + ext));
  return found === undefined ? target : target + found;
}

const parentImportRule = defineRule({
  meta: {
    messages: {
      parent: says(
        "an import that climbs out of its folder reads differently from every file and changes when the file moves",
        "write it as `{{alias}}` (vp check --fix does it)",
        "apps/{{app}}/package.json",
      ),
    },
    fixable: "code",
  },
  create(context) {
    const [, app, at] = /\/apps\/(web|server|cli)\/src\/(.+)$/u.exec(context.filename.replaceAll("\\", "/")) ?? [];
    if (app === undefined || at === undefined) return {};
    // The string itself is replaced, quotes kept, so the fix is the same for every kind of import.
    const check = (source: { type: string; value?: unknown; range: [number, number] } | null | undefined) => {
      if (source?.type !== "Literal" || typeof source.value !== "string" || !source.value.startsWith("../")) return;
      const spec = source.value;
      const ups = spec.split("/").filter((p) => p === "..").length;
      // Out of src: the server's generated queries are #db/ (its package.json imports); nothing else is reached.
      const out = ups >= at.split("/").length;
      const generated = /^(?:\.\.\/)+db\/generated\/(.+)$/u.exec(spec)?.[1];
      if (out && (app !== "server" || generated === undefined)) return;
      const alias = out ? `#db/${generated}` : `#/${withExtension(context.filename, spec, joinPath(at, spec))}`;
      const [start, end] = source.range;
      context.report({ node: source, messageId: "parent", data: { alias, app }, fix: (fixer) => fixer.replaceTextRange([start + 1, end - 1], alias) });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
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
      const to = packageOf(resolve(dirname(context.filename), source.value));
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

/** Words that end in s and still name one thing; a service named for one of them is singular. */
const singularInS = new Set(["Status", "Alias", "Canvas", "Lens", "Progress", "Access", "Address", "Ingress"]);
const lastWord = (name: string) => /[A-Z][a-z0-9]*$/u.exec(name)?.[0] ?? name;
const looksPlural = (name: string) => name.endsWith("s") && !singularInS.has(lastWord(name));
const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The folder of a server module's service file (apps/server/src/{core,platform/x,modules/x,gateway/x}/x.ts), or undefined. */
const serviceFolderOf = (filename: string): string | undefined => {
  const [, folder, file] = /\/apps\/server\/src\/(?:platform\/|modules\/|gateway\/)?([^/]+)\/([^/]+)\.ts$/u.exec(filename.replaceAll("\\", "/")) ?? [];
  const inModules = /\/apps\/server\/src\/(?:platform|modules|gateway)\/[^/]+\/[^/]+\.ts$/u.test(filename.replaceAll("\\", "/"));
  return folder !== undefined && folder === file && (inModules || folder === "core") ? folder : undefined;
};
const singularOf = (word: string) => word.replace(/(ies|s)$/u, (e) => (e === "ies" ? "y" : ""));

const singularService = defineRule({
  meta: {
    messages: {
      plural: says(
        "the module {{folder}} is named in the plural, but a service is one thing: the one that manages its concept",
        "name the folder, the file, the service's interface and its factory with the concept's singular word, the same as its table (`modules/{{singular}}/{{singular}}.ts`, `export interface {{Singular}}`, `make{{Singular}}`)",
        ".agents/skills/vv-typescript/SKILL.md",
      ),
      factory: says(
        "`{{name}}` in the module {{folder}} makes a service under another name than its folder's",
        "the module's one factory is `make{{Service}}(deps)`, returning `{{Service}}`; a helper factory lives in another file of the module",
        ".agents/skills/vv-typescript/SKILL.md",
      ),
      missing: says(
        "the module {{folder}} has a factory but no interface named after it, so other modules cannot name the service's type",
        "`export interface {{Service}} { … }` (or `export type {{Service}} = …`) next to `make{{Service}}`; a protocol shape of that name is read as `T.{{Service}}`",
        ".agents/skills/vv-typescript/SKILL.md",
      ),
    },
  },
  create(context) {
    const folder = serviceFolderOf(context.filename);
    if (folder === undefined) return {};
    const service = pascal(folder);
    let factory: ESTree.Node | undefined;
    let declared = false;
    return {
      Program(node) {
        if (looksPlural(service))
          context.report({ node, messageId: "plural", data: { folder, singular: singularOf(folder), Singular: pascal(singularOf(folder)) } });
      },
      ExportNamedDeclaration(node) {
        const d = node.declaration;
        if (d?.type === "FunctionDeclaration" && d.id && /^make[A-Z]/u.test(d.id.name)) {
          factory = d.id;
          if (d.id.name !== `make${service}`) context.report({ node: d.id, messageId: "factory", data: { name: d.id.name, folder, Service: service } });
        }
        if ((d?.type === "TSInterfaceDeclaration" || d?.type === "TSTypeAliasDeclaration") && d.id.name === service) declared = true;
      },
      "Program:exit"() {
        if (factory !== undefined && !declared) context.report({ node: factory, messageId: "missing", data: { folder, Service: service } });
      },
    };
  },
});

/** The server's services, read once when the plugin loads. */
const serviceNames = new Set(
  globSync("apps/server/src/{core,platform/*,modules/*,gateway/*}/*.ts", { cwd: repo })
    .filter((f) => {
      const parts = f.split("/");
      return parts.at(-1)?.slice(0, -3) === parts.at(-2);
    })
    .flatMap((f) => [...readFileSync(resolve(repo, f), "utf8").matchAll(/^export (?:async )?function make(\w+)\b/gmu)].map((m) => m[1] ?? "")),
);

const protocolNamespace = defineRule({
  meta: {
    messages: {
      named: says(
        "{{name}} is both a protocol shape and a server service, so importing the shape by name takes the service's name in this file",
        '`import type * as T from "@vibevalley/protocol"` and write `T.{{name}}` (the file\'s other protocol types too, so they read alike)',
        "docs/style/naming.md",
      ),
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@vibevalley/protocol") return;
        for (const s of node.specifiers) {
          if (s.type !== "ImportSpecifier") continue;
          const name = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
          if (serviceNames.has(name)) context.report({ node: s, messageId: "named", data: { name } });
        }
      },
    };
  },
});

const hostIoModules = new Set(["node:fs", "node:fs/promises", "node:child_process", "node:net", "node:http", "node:https", "electron"]);
const nonBaseFolders = new Set([
  "infra",
  "ui",
  "state",
  "features",
  "platform",
  "modules",
  "gateway",
  "commands",
  "screens",
  "sections",
  "preload",
  "brain",
  "tools",
  "llm",
  "realtime",
  "primitives",
]);

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
      preloadLeak: says(
        "the Electron preload bridge runs in a sandboxed renderer context and cannot import {{source}}",
        "keep preload limited to electron's contextBridge/ipcRenderer, @vibevalley/* contracts, and ../base/* pure helpers",
        "docs/subsystems/app.md",
      ),
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (/\.(?:test|spec|stories)\.tsx?$/u.test(normalized)) return {};
    const match = /\/(apps|packages)\/([^/]+)\/src\/(.+)$/u.exec(normalized);
    if (!match) return {};
    const [, kind, pkg, at] = match;
    const top = at?.split("/")[0];
    if (top !== "base" && !(kind === "apps" && pkg === "desktop" && top === "preload")) return {};

    const checkSpec = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec !== "string" || at === undefined) return;
      if (top === "base") {
        if (hostIoModules.has(spec)) {
          context.report({ node, messageId: "baseIo", data: { source: spec } });
          return;
        }
        if (spec.startsWith(".") || spec.startsWith("#/")) {
          const target = spec.startsWith("#/") ? spec.slice(2) : joinPath(at, spec);
          const targetTop = target.split("/")[0] ?? "";
          if (nonBaseFolders.has(targetTop)) {
            context.report({ node, messageId: "baseUpward", data: { target: `src/${targetTop}` } });
          }
        }
        return;
      }
      // apps/desktop/src/preload/**
      if (hostIoModules.has(spec) && spec !== "electron") {
        context.report({ node, messageId: "preloadLeak", data: { source: spec } });
        return;
      }
      if (spec.startsWith(".") || spec.startsWith("#/")) {
        const target = spec.startsWith("#/") ? spec.slice(2) : joinPath(at, spec);
        const targetTop = target.split("/")[0] ?? "";
        if (targetTop !== "preload" && targetTop !== "base") {
          context.report({ node, messageId: "preloadLeak", data: { source: spec } });
        }
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
    "no-wall-clock": noWallClock,
    "no-test-sleep": noTestSleep,
    "no-comment-divider": noCommentDivider,
    "no-cjk-literal": noCjkLiteral,
    "no-hex-color": noHexColor,
    "style-attrs": styleAttrs,
    "no-copy-selector": noCopySelector,
    "design-tokens": designTokens,
    "page-layers": pageLayersRule,
    "subpackage-layers": subpackageLayersRule,
    "parent-import": parentImportRule,
    "no-cross-package-path": noCrossPackagePath,
    "db-door": dbDoor,
    "child-process-door": childProcessDoor,
    "dropped-timer": droppedTimer,
    "sync-fs": syncFs,
    "page-store": pageStore,
    "stored-door": storedDoor,
    "act-door": actDoor,
    "failure-tone": failureTone,
    "one-absent": oneAbsent,
    "global-doors": globalDoors,
    "native-control": nativeControl,
    "singular-service": singularService,
    "protocol-namespace": protocolNamespace,
  },
});
