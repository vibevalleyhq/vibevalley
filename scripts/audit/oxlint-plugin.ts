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
    if (!["effect", "effect/Effect", "node:timers", "timers", "node:timers/promises", "timers/promises"].includes(source)) return undefined;
    const imported = definition.node;
    const name = imported.type === "ImportSpecifier" ? (imported.imported.type === "Identifier" ? imported.imported.name : imported.imported.value) : "";
    return [source === "effect/Effect" ? "Effect" : "", name].filter(Boolean).join(".");
  }
  return node.name === "globalThis" ? "" : node.name;
};
const timerCalls = new Set(["setTimeout", "setInterval"]);

const noWallClock = defineRule({
  meta: {
    messages: {
      wallClock: says(
        "this reads or waits on the wall clock, which a test's TestClock cannot move",
        "in Effect code `yield* Clock.currentTimeMillis` to read and `Effect.sleep` to wait; in a class, the `Time` it was handed (`time.now()`, `time.sleep(ms)`)",
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
        "wait for the thing itself: `until(() => …)`, `untilGot`, `waitFor` or `whenState` for work in the background, `TestClock.adjust(…)` through a window, `gate()` to hold a fake until the test lets it go, `aTurn` before checking nothing happened",
        "packages/testkit/src/until.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        const name = clockCall(c, context);
        if (
          timerCalls.has(name ?? "") ||
          name === "Effect.sleep" ||
          (c.type === "MemberExpression" && c.property.type === "Identifier" && c.property.name === "waitForTimeout")
        )
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

function styleBinding(node: Extract<ESTree.Node, { type: "Identifier" }>, context: Context) {
  for (let scope: Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return variable.defs[0];
  }
  return undefined;
}

function styleKey(node: ESTree.Node): string | undefined {
  return node.type === "Identifier" ? node.name : node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function stylexApi(node: ESTree.Node, context: Context, seen = new Set<ESTree.Node>()): string | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (node.type === "MemberExpression") {
    const owner = stylexApi(node.object, context, seen);
    const key = styleKey(node.property);
    return owner !== undefined && key !== undefined ? [owner, key].filter(Boolean).join(".") : undefined;
  }
  if (node.type !== "Identifier") return undefined;
  const definition = styleBinding(node, context);
  if (definition?.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration") {
    if (definition.parent.source.value !== "@stylexjs/stylex") return undefined;
    const imported = definition.node.type === "ImportSpecifier" ? styleKey(definition.node.imported) : "";
    return imported === "default" ? "" : imported;
  }
  if (definition?.type !== "Variable" || definition.parent?.type !== "VariableDeclaration" || definition.parent.kind !== "const") return undefined;
  const binding = definition.node;
  if (binding.type !== "VariableDeclarator" || binding.init === null) return undefined;
  if (binding.id.type === "Identifier") return stylexApi(binding.init, context, seen);
  if (binding.id.type === "ObjectPattern" && stylexApi(binding.init, context, seen) === "") {
    const property = binding.id.properties.find((p) => p.type === "Property" && p.value.type === "Identifier" && p.value.name === node.name);
    return property?.type === "Property" ? styleKey(property.key) : undefined;
  }
  return undefined;
}

type StyleValue = { node: ESTree.Node; property: string | undefined; value: string | number; disabled: boolean };

/** Walk only values returned to StyleX, not selectors, function tests, asset names or unrelated literals. */
function stylexValues(context: Context, inspect: (value: StyleValue) => void) {
  function visit(node: ESTree.Node, depth: number, property: string | undefined, disabled: boolean, seen: Set<ESTree.Node>) {
    if (seen.has(node)) return;
    seen.add(node);
    switch (node.type) {
      case "Identifier": {
        const definition = styleBinding(node, context);
        if (
          definition?.type === "Variable" &&
          definition.parent?.type === "VariableDeclaration" &&
          definition.parent.kind === "const" &&
          definition.node.type === "VariableDeclarator" &&
          definition.node.id.type === "Identifier" &&
          definition.node.init !== null
        ) {
          visit(definition.node.init, depth, property, disabled, seen);
        }
        break;
      }
      case "ObjectExpression":
        for (const entry of node.properties) {
          if (entry.type === "SpreadElement") visit(entry.argument, depth, property, disabled, seen);
          else {
            const key = styleKey(entry.key);
            const pseudoElement = key?.startsWith("::") === true;
            const inDisabled = key !== undefined && /:disabled\b/u.test(key.replace(/:not\([^)]*\)/gu, ""));
            visit(
              entry.value,
              depth === 1 && pseudoElement ? 1 : Math.max(0, depth - 1),
              depth === 1 && !pseudoElement ? key : property,
              disabled || inDisabled,
              seen,
            );
          }
        }
        break;
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        if (node.body !== null) visit(node.body, depth, property, disabled, seen);
        break;
      case "BlockStatement":
        for (const statement of node.body) visit(statement, depth, property, disabled, seen);
        break;
      case "ReturnStatement":
        if (node.argument) visit(node.argument, depth, property, disabled, seen);
        break;
      case "IfStatement":
        visit(node.consequent, depth, property, disabled, seen);
        if (node.alternate) visit(node.alternate, depth, property, disabled, seen);
        break;
      case "ConditionalExpression":
        visit(node.consequent, depth, property, disabled, seen);
        visit(node.alternate, depth, property, disabled, seen);
        break;
      case "LogicalExpression":
        visit(node.left, depth, property, disabled, seen);
        visit(node.right, depth, property, disabled, seen);
        break;
      case "CallExpression": {
        const api = stylexApi(node.callee, context);
        if (api === "firstThatWorks" || api?.startsWith("types.") === true) {
          for (const argument of node.arguments) visit(argument, depth, property, disabled, seen);
        }
        break;
      }
      case "ArrayExpression":
        for (const element of node.elements) if (element) visit(element, depth, property, disabled, seen);
        break;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        visit(node.expression, depth, property, disabled, seen);
        break;
      case "Literal":
        if (typeof node.value === "string" || typeof node.value === "number") inspect({ node, property, value: node.value, disabled });
        break;
      case "UnaryExpression":
        if ((node.operator === "-" || node.operator === "+") && node.argument.type === "Literal" && typeof node.argument.value === "number") {
          inspect({ node, property, value: node.argument.value * (node.operator === "-" ? -1 : 1), disabled });
        }
        break;
      case "TemplateLiteral":
        inspect({ node, property, value: node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("${}"), disabled });
        for (const expression of node.expressions) visit(expression, depth, property, disabled, seen);
        break;
      default:
        break;
    }
    seen.delete(node);
  }
  return {
    CallExpression(node: ESTree.CallExpression) {
      const api = stylexApi(node.callee, context);
      let index = 0;
      let depth: number;
      switch (api) {
        case "create":
        case "keyframes":
        case "viewTransitionClass":
          depth = 2;
          break;
        case "positionTry":
          depth = 1;
          break;
        case "createTheme":
          index = 1;
          depth = 0;
          break;
        case "defineVars":
        case "defineConsts":
          depth = 0;
          break;
        default:
          return;
      }
      const argument = node.arguments[index];
      if (argument) visit(argument, depth, undefined, false, new Set());
    },
  };
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
      ...stylexValues(context, check),
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

const stylexOnly = defineRule({
  meta: {
    messages: {
      important: says(
        "`!important` inside a StyleX declaration breaks last-rule-wins atomic composition",
        "remove `!important` and rely on `@layer stylex` ordering or conditional StyleX style arguments",
        "apps/web/src/ui/positioner.ts",
      ),
      tailwindVar: says(
        "Tailwind `--tw-*` internal variables have no runtime definition under StyleX",
        "express the shadow, ring, gradient or transform directly in `stylex.create(...)` using host `--color-*` and `--shadow-*` tokens",
        "docs/style/design.md",
      ),
      tailwindShadow: says(
        "`0 0 transparent` is a compiled Tailwind ring-slot placeholder rather than a real shadow layer",
        "keep only the active shadow layers such as `boxShadow: 'var(--shadow-float)'` or `'inset 0 0 0 2px var(--color-rim)'`",
        "docs/style/design.md",
      ),
      tailwindGrid: says(
        "`repeat(1, minmax(0, 1fr))` is compiled Tailwind `grid-cols-1` output",
        "write `gridTemplateColumns: 'minmax(0, 1fr)'` directly",
        "docs/style/design.md",
      ),
      tailwindTransform: says(
        "`transform, translate, scale, rotate` is compiled Tailwind `transition-transform` output rather than the property that moves",
        "list only the animated property such as `transitionProperty: 'rotate'` or `'translate'`",
        "docs/style/design.md",
      ),
    },
  },
  create(context) {
    return {
      ...stylexValues(context, ({ node, property, value }) => {
        if (property?.startsWith("--tw-") === true) {
          context.report({ node, messageId: "tailwindVar" });
          return;
        }
        if (property === "content" || typeof value !== "string") return;
        if (/!\s*important\b/iu.test(value)) context.report({ node, messageId: "important" });
        if (/--tw-[\w-]+/u.test(value)) context.report({ node, messageId: "tailwindVar" });
        if (/\b0\s+0\s+transparent\b/u.test(value)) context.report({ node, messageId: "tailwindShadow" });
        if (/repeat\(\s*1\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/u.test(value)) context.report({ node, messageId: "tailwindGrid" });
        if (property === "transitionProperty" && /^transform,\s*translate,\s*scale,\s*rotate$/u.test(value.trim()))
          context.report({ node, messageId: "tailwindTransform" });
      }),
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
        if (attr !== "style" || node.value === null) return;
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
      ...stylexValues(context, ({ node, property, value, disabled }) => {
        if (property === undefined) return;
        const kind = offTokens(property, value, disabled);
        if (kind) context.report({ node, messageId: kind });
      }),
      ...classStrings((node, { token, kind }) => {
        if (kind !== "hex") context.report({ node, messageId: `${kind}Class`, data: { token } });
      }),
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
    .filter((f) => f !== "features" && f !== "modules" && f !== "gateway");
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

/** The one place an async body is the boundary. */
function inEffectPromise(node: { parent?: unknown }): boolean {
  const isWrapper = (n: unknown): boolean => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
    const call = n as { type?: string; callee?: { type?: string; object?: { type?: string; name?: string }; property?: { type?: string; name?: string } } };
    const c = call.callee;
    return (
      call.type === "CallExpression" &&
      c?.type === "MemberExpression" &&
      c.object?.type === "Identifier" &&
      c.object.name === "Effect" &&
      c.property?.type === "Identifier" &&
      (c.property.name === "tryPromise" || c.property.name === "promise")
    );
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
  const parent = node.parent as { type?: string; key?: { type?: string; name?: string }; parent?: { parent?: unknown } } | undefined;
  if (isWrapper(parent)) return true;
  return parent?.type === "Property" && parent.key?.type === "Identifier" && parent.key.name === "try" && isWrapper(parent.parent?.parent);
}

const promiseBoundary = defineRule({
  meta: {
    messages: {
      async: says(
        "an async function in the server is a loop, a wait or an error path written outside Effect, where interruption, the Clock and typed errors do not reach",
        "write it as `Effect.gen(function* () { … })`, and keep the library's one Promise call inside `Effect.tryPromise({ try: () => lib.call(…), catch: (e) => new XError({ cause: e }) })`",
        "docs/subsystems/foundation.md",
      ),
      promise: says(
        "a new Promise in the server is a wait written by hand, outside interruption and the Clock",
        "`Effect.callback((resume) => …)` for a callback API, a `Deferred` for one value handed over later, a `Queue` for many",
        "docs/subsystems/foundation.md",
      ),
      steps: says(
        "this async function awaits more than once inside Effect.tryPromise or Effect.promise, so the steps between its awaits (checks, branches, errors) run where interruption and typed errors do not reach",
        "keep one library call per wrapper and write the steps in the Effect around them: `const a = yield* Effect.tryPromise({ try: () => lib.first(…), catch })`, check `a` there (`return yield* Effect.fail(…)`), then `yield* Effect.tryPromise({ try: () => lib.next(a), catch })`",
        "apps/server/src/modules/tool/tool.ts",
      ),
    },
  },
  create(context) {
    const check = (node: Parameters<typeof inEffectPromise>[0] & { async?: boolean }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
      if (node.async === true && !inEffectPromise(node)) context.report({ node: node as never, messageId: "async" });
    };
    const awaits = new Map<unknown, number>();
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      AwaitExpression(node) {
        const owner = ownerOf(node);
        if (owner === undefined || !owner.async || !inEffectPromise(owner)) return;
        const n = (awaits.get(owner.fn) ?? 0) + 1;
        awaits.set(owner.fn, n);
        if (n === 2) context.report({ node, messageId: "steps" });
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Promise") context.report({ node, messageId: "promise" });
      },
    };
  },
});

const tryPromiseCatch = defineRule({
  meta: {
    messages: {
      thunk: says(
        "Effect.tryPromise given only a function fails with Cause.UnknownError, and what really went wrong (the library's error and its message) is lost",
        "`Effect.tryPromise({ try: (signal) => lib.call(…, { signal }), catch: (e) => new XError({ message: messageOf(e), cause: e }) })`, with the module's own error or refusal in catch",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        const arg = node.arguments[0];
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "Effect" &&
          c.property.type === "Identifier" &&
          c.property.name === "tryPromise" &&
          (arg?.type === "ArrowFunctionExpression" || arg?.type === "FunctionExpression")
        )
          context.report({ node, messageId: "thunk" });
      },
    };
  },
});

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

const dbDoor = defineRule({
  meta: {
    messages: {
      client: says(
        "a module that takes the SqlClient itself decides again what a failed query becomes, outside the Db service",
        '`const db = yield* Db` and pass the generated query to it (`db.run(q.x(…))`); a type in a signature is `import type { SqlClient } from "effect/sql"`',
        "apps/server/src/infra/db.ts",
      ),
      whole: says(
        "Db taken apart can be renamed, and then run (a failure is a defect) and attempt (a failure stays) read alike",
        "`const db = yield* Db` and `db.run(…)`, `db.attempt(…)`, `db.one(…)`, `db.inTx(…)`, `db.attemptTx(…)`",
        "apps/server/src/infra/db.ts",
      ),
      runCaught: says(
        "db.run turns the database's failure into a defect, so {{catcher}} around it never sees one",
        "`db.attempt(…)` when the failure is told or retried, and catch its SqlError; keep db.run when a failure is a bug",
        "apps/server/src/infra/db.ts",
      ),
      transaction: says(
        "a withTransaction of its own leaves the database's failure for each module to turn into a defect or a refusal by hand",
        '`inTx(work)` when a failure is a bug, `attemptTx(work)` when it is told to the owner or retried (`.pipe(Effect.catchTag("SqlError", …))`)',
        "apps/server/src/infra/db.ts",
      ),
    },
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("apps/server/src/infra/db.ts")) return {};
    return {
      ImportDeclaration(node) {
        const from = node.source.value;
        if ((from !== "effect/sql" && from !== "effect/sql/SqlClient") || node.importKind === "type") return;
        for (const s of node.specifiers)
          // The whole namespace carries the SqlClient as well.
          if (
            s.type === "ImportNamespaceSpecifier" ||
            (from === "effect/sql" &&
              s.type === "ImportSpecifier" &&
              s.importKind !== "type" &&
              s.imported.type === "Identifier" &&
              s.imported.name === "SqlClient")
          )
            context.report({ node: s, messageId: "client" });
      },
      VariableDeclarator(node) {
        const init = node.init;
        if (
          node.id.type === "ObjectPattern" &&
          init?.type === "YieldExpression" &&
          init.delegate &&
          init.argument?.type === "Identifier" &&
          init.argument.name === "Db"
        )
          context.report({ node, messageId: "whole" });
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === "MemberExpression" && c.property.type === "Identifier" && c.property.name === "withTransaction")
          context.report({ node, messageId: "transaction" });
        // Effect.result(db.run(…)) and its kin: a catcher around what cannot fail.
        const first = node.arguments[0];
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "Effect" &&
          c.property.type === "Identifier" &&
          ["result", "catch", "catchTag", "orElseSucceed", "option", "exit"].includes(c.property.name) &&
          first?.type === "CallExpression" &&
          first.callee.type === "MemberExpression" &&
          first.callee.object.type === "Identifier" &&
          first.callee.object.name === "db" &&
          first.callee.property.type === "Identifier" &&
          first.callee.property.name === "run"
        )
          context.report({ node, messageId: "runCaught", data: { catcher: `Effect.${c.property.name}` } });
      },
    };
  },
});

const yieldInLoop = defineRule({
  meta: {
    messages: {
      loop: says(
        "a for…of with yield* in its body runs the effects one by one without saying so, and hides a query per item",
        "`yield* Effect.forEach(items, (x) => …, { discard: true })` (in order, one at a time, as the loop was), with `{ concurrency: n }` where the items do not wait on each other; a batch query for a query per row. A loop that leaves early (break, continue, return) stays a loop",
        ".agents/skills/vv-effect/SKILL.md",
      ),
    },
  },
  create(context) {
    /** Whether n, not counting functions inside it, holds a node of one of these types. */
    const holds = (n: unknown, types: readonly string[]): boolean => {
      if (n === null || typeof n !== "object") return false;
      const node = n as { type?: unknown };
      if (typeof node.type === "string") {
        if (types.includes(node.type)) return true;
        if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") return false;
      }
      return Object.entries(n).some(([k, v]) => k !== "parent" && (Array.isArray(v) ? v.some((c) => holds(c, types)) : holds(v, types)));
    };
    return {
      ForOfStatement(node) {
        if (holds(node.body, ["YieldExpression"]) && !holds(node.body, ["BreakStatement", "ContinueStatement", "ReturnStatement"]))
          context.report({ node, messageId: "loop" });
      },
    };
  },
});

const scopedFibers = defineRule({
  meta: {
    messages: {
      detached: says(
        "Effect.{{name}} starts a fiber no scope owns: it outlives the service that started it, and a test's end does not stop it",
        "`Effect.forkScoped` (the service's scope), `FiberSet.run` / `FiberMap.run` / `FiberHandle.run` for the service's own sets, `FiberSet.makeRuntime` for a callback; a fiber that must outlive its caller on purpose says why in a disable comment",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "Effect" &&
          c.property.type === "Identifier" &&
          ["forkDetach", "forkDaemon", "runFork", "runForkWith"].includes(c.property.name)
        )
          context.report({ node, messageId: "detached", data: { name: c.property.name } });
      },
    };
  },
});

const clockInEffect = defineRule({
  meta: {
    messages: {
      unsafe: says(
        "currentTimeMillisUnsafe in an Effect generator reads the time outside Effect, where a test's Clock and the trace do not see it",
        "`yield* Clock.currentTimeMillis`; currentTimeMillisUnsafe is for a synchronous callback (an outside library's, a timer's) that cannot yield",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "MemberExpression" || c.property.type !== "Identifier" || c.property.name !== "currentTimeMillisUnsafe") return;
        // The nearest function: a generator yields; any other is a callback, where the unsafe read is the way.
        let at: ESTree.Node = node.parent;
        while (at.type !== "FunctionExpression" && at.type !== "ArrowFunctionExpression" && at.type !== "FunctionDeclaration" && at.type !== "Program")
          at = at.parent;
        if ((at.type === "FunctionExpression" || at.type === "FunctionDeclaration") && at.generator) context.report({ node, messageId: "unsafe" });
      },
    };
  },
});

const syncFs = defineRule({
  meta: {
    messages: {
      sync: says(
        "{{name}} holds the event loop while it reads or writes, so every helper's stream and every request waits on the disk",
        "`yield* FileSystem.FileSystem` and its readFileString, writeFileString, rename, readDirectory…; a file the server keeps is a `keptFile` (infra/files.ts); a callback outside Effect uses node:fs/promises",
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
        "`useTimeout()` or `useInterval(fn, ms)` from `#/base/timer.ts` in a component; in an effect, keep the handle and return `() => clearTimeout(t)`; a store that lives as long as the page keeps the handle too, or says why it need not with a disable comment",
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

const atomDoor = defineRule({
  meta: {
    messages: {
      atom: says(
        "Atom's API is marked unstable, and only apps/web/src/state may stand on it, so that a change in it is fixed in one folder",
        "read through state: `useAtom`, `useRegistry` (state/atom.ts), `defineIntent`, `useIntents` (state/intent.ts); a primitive state lacks goes into state",
        "docs/subsystems/app.md",
      ),
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    if (!file.includes("/apps/web/src/") || file.includes("/apps/web/src/state/")) return {};
    return {
      ImportDeclaration(node) {
        if (node.source.value === "effect/reactivity" || node.source.value.startsWith("effect/reactivity/")) context.report({ node, messageId: "atom" });
      },
    };
  },
});

const isSubpath = (spec: string, prefix: string) => spec === prefix || spec.startsWith(`${prefix}/`);

const unstableEffectDoor = defineRule({
  meta: {
    messages: {
      unstable: says(
        "`{{source}}` is an unstable or experimental Effect subpath whose API may change on a minor bump",
        "keep it inside `apps/server/src/infra/` or `apps/web/src/state/` and expose a small stable helper there",
        "docs/subsystems/foundation.md",
      ),
      rpc: says(
        "`{{source}}` wires the RPC transport directly outside the farm's typed client and server doors",
        "declare contracts in `packages/protocol/src/rpc.ts`, serve in `apps/server/src/gateway/http/`, and call via `apps/web/src/infra/`",
        "docs/subsystems/foundation.md",
      ),
      observability: says(
        "`{{source}}` configures telemetry exporters outside the server's bootstrap door",
        "keep OTLP wiring in `apps/server/src/main.ts` or `apps/server/src/infra/`, and trace calls with `Effect.fn` or `Metric`",
        "docs/subsystems/foundation.md",
      ),
      cli: says(
        "`{{source}}` pulls command-line parsing into code that is not a CLI entrypoint",
        "keep `effect/cli` inside `apps/cli/src/` and `apps/server/src/chat/`",
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    const raw = context.filename.replaceAll("\\", "/");
    const file = raw.startsWith("/") ? raw : `/${raw}`;
    const check = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec !== "string" || !spec.startsWith("effect/")) return;
      if (isSubpath(spec, "effect/unstable") || isSubpath(spec, "effect/experimental")) {
        if (!file.includes("/apps/server/src/infra/") && !file.includes("/apps/web/src/state/"))
          context.report({ node, messageId: "unstable", data: { source: spec } });
        return;
      }
      if (isSubpath(spec, "effect/rpc")) {
        if (!file.endsWith("/packages/protocol/src/rpc.ts") && !file.includes("/apps/server/src/gateway/http/") && !file.includes("/apps/web/src/infra/"))
          context.report({ node, messageId: "rpc", data: { source: spec } });
        return;
      }
      if (isSubpath(spec, "effect/observability")) {
        if (!file.endsWith("/apps/server/src/main.ts") && !file.includes("/apps/server/src/infra/"))
          context.report({ node, messageId: "observability", data: { source: spec } });
        return;
      }
      if (isSubpath(spec, "effect/cli") && !file.includes("/apps/cli/src/") && !file.includes("/apps/server/src/chat/"))
        context.report({ node, messageId: "cli", data: { source: spec } });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
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

/** JavaScript's own errors: plain classes, never tagged. */
const nativeErrors = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "DOMException"]);
const taggedName = /(?:Error|Failed|Failure|Refused)$/u;

/** Imported classes are recognized by error-like names; tagged classes imported under other names need review. */
const noInstanceofTagged = defineRule({
  meta: {
    messages: {
      tagged: says(
        "instanceof tells a tagged error by its class: it narrows nothing in an error typed unknown, and leads a function that sorts errors to take unknown instead of the union its callers pass",
        '`Predicate.isTagged(e, "{{name}}")` over the union the callers pass, or `Effect.catchTag("{{name}}", …)` on the Effect',
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    const local = new Set<string>();
    return {
      Program(node) {
        for (const statement of node.body) {
          const declared = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
          if (
            declared?.type === "ClassDeclaration" &&
            declared.id &&
            declared.superClass &&
            /\bTaggedError\b/u.test(context.sourceCode.getText(declared.superClass))
          )
            local.add(declared.id.name);
        }
      },
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return;
        const r = node.right;
        const name = r.type === "Identifier" ? r.name : r.type === "MemberExpression" && r.property.type === "Identifier" ? r.property.name : undefined;
        if (name !== undefined && (local.has(name) || (taggedName.test(name) && !nativeErrors.has(name))))
          context.report({ node, messageId: "tagged", data: { name } });
      },
    };
  },
});

type Expression = ESTree.Expression | ESTree.PrivateIdentifier;

/** The operand of an && chain that touches the next one: a && b && c is ((a && b) && c), so b meets c. */
const lastOperand = (n: Expression): Expression => (n.type === "LogicalExpression" && n.operator === "&&" ? lastOperand(n.right) : n);
const firstOperand = (n: Expression): Expression => (n.type === "LogicalExpression" && n.operator === "&&" ? firstOperand(n.left) : n);

const noObjectGuard = defineRule({
  meta: {
    messages: {
      guard: says(
        "a hand-written object check repeats Effect's guard, and is where a decoder written by hand starts",
        '`Predicate.isObject(x)` (not null, not an array), `Predicate.hasProperty(x, "key")` to read one field, or a Schema (`Schema.decodeUnknownResult`) to read the shape',
        "docs/subsystems/foundation.md",
      ),
    },
  },
  create(context) {
    const text = (n: Expression) => context.sourceCode.getText(n);
    /** What `typeof x === "object"` checks, or undefined. */
    const objectOf = (n: Expression) => {
      if (n.type !== "BinaryExpression" || (n.operator !== "===" && n.operator !== "==")) return undefined;
      const [t, v] = n.left.type === "UnaryExpression" ? [n.left, n.right] : [n.right, n.left];
      return t.type === "UnaryExpression" && t.operator === "typeof" && v.type === "Literal" && v.value === "object" ? text(t.argument) : undefined;
    };
    /** What `x !== null` checks, or undefined. */
    const notNullOf = (n: Expression) => {
      if (n.type !== "BinaryExpression" || (n.operator !== "!==" && n.operator !== "!=")) return undefined;
      const isNull = (o: Expression) => o.type === "Literal" && o.value === null && o.raw === "null";
      return isNull(n.right) ? text(n.left) : isNull(n.left) ? text(n.right) : undefined;
    };
    return {
      LogicalExpression(node) {
        if (node.operator !== "&&") return;
        const [a, b] = [lastOperand(node.left), firstOperand(node.right)];
        const x = objectOf(a) ?? objectOf(b);
        if (x !== undefined && (notNullOf(a) === x || notNullOf(b) === x)) context.report({ node, messageId: "guard" });
      },
    };
  },
});

type Node = ESTree.Node;

/** Effect's own functions that return an Effect; the rest of the namespace (Effect.run*, Effect.is*, Effect.fn*) does not. */
const effectMaker = (n: Node): boolean =>
  n.type === "MemberExpression" &&
  n.object.type === "Identifier" &&
  n.object.name === "Effect" &&
  n.property.type === "Identifier" &&
  !/^(?:run|is|fn)/u.test(n.property.name);

/** Effect.fn(…) called with its body: what it is named (undefined when it was given no name), or "untraced". */
const tracedAs = (n: Node): { name: string | undefined; at: Node } | "untraced" | undefined => {
  if (n.type !== "CallExpression") return undefined;
  const c = n.callee;
  if (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "Effect" && c.property.type === "Identifier") {
    if (c.property.name === "fnUntraced") return "untraced";
    if (c.property.name === "fn") return { name: undefined, at: n };
  }
  if (c.type === "CallExpression" && c.callee.type === "MemberExpression" && c.callee.object.type === "Identifier" && c.callee.object.name === "Effect") {
    const p = c.callee.property;
    if (p.type === "Identifier" && p.name === "fn") {
      const arg = c.arguments[0];
      return { name: arg?.type === "Literal" && typeof arg.value === "string" ? arg.value : undefined, at: c };
    }
  }
  return undefined;
};

const isFunction = (n: Node) => n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration";

/** Imported delegates and dynamic lookups hide their return type from this syntax-only check. */
const serviceMethodNames = defineRule({
  meta: {
    messages: {
      unnamed: says(
        "{{service}}.{{method}} returns an Effect but opens no span, so the OTLP traces cannot show the call",
        '`{{method}}: Effect.fn("{{service}}.{{method}}")(function* (…) { … })`, with combinators passed after the generator rather than piped; `Effect.fnUntraced(function* (…) { … })` on a hot path or a thin accessor',
        ".agents/skills/vv-effect/SKILL.md",
      ),
      name: says(
        "{{service}}.{{method}}'s span is named {{given}}, so a trace shows a call other than the one made",
        '`Effect.fn("{{service}}.{{method}}")(function* (…) { … })`',
        ".agents/skills/vv-effect/SKILL.md",
      ),
    },
  },
  create(context) {
    /** A name's const initialiser; a name declared twice in the file is left unresolved rather than guessed. */
    const consts = new Map<string, Node | undefined>();
    const returns = new Map<Node, Node[]>();
    const services: { service: string; object: ESTree.ObjectExpression }[] = [];

    /** A name's initialiser, or a member of an object literal a name holds in this file (`helpers.m`, a method handed
     * over from a sibling object). */
    const resolve = (n: Node): Node => {
      if (n.type === "Identifier") return consts.get(n.name) ?? n;
      if (n.type !== "MemberExpression" || n.computed || n.object.type !== "Identifier" || n.property.type !== "Identifier") return n;
      const held = consts.get(n.object.name);
      const name = n.property.name;
      const member =
        held?.type === "ObjectExpression"
          ? held.properties.find((p) => p.type === "Property" && !p.computed && p.key.type === "Identifier" && p.key.name === name)
          : undefined;
      return member?.type === "Property" ? resolve(member.value) : n;
    };
    const returnedBy = (fn: Node): Node[] => {
      if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") return [fn.body];
      return returns.get(fn) ?? [];
    };
    /** Whether the syntax alone shows an Effect. */
    const isEffect = (n: Node, seen: Set<Node>): boolean => {
      if (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "TSNonNullExpression" || n.type === "ParenthesizedExpression")
        return isEffect(n.expression, seen);
      if (n.type === "ConditionalExpression") return isEffect(n.consequent, seen) || isEffect(n.alternate, seen);
      if (n.type === "LogicalExpression") return isEffect(n.left, seen) || isEffect(n.right, seen);
      if (n.type !== "CallExpression") return false;
      const c = n.callee;
      if (effectMaker(c)) return true;
      if (c.type === "MemberExpression" && c.property.type === "Identifier" && c.property.name === "pipe")
        return isEffect(c.object, seen) || n.arguments.some((a) => effectMaker(a.type === "CallExpression" ? a.callee : a));
      if (c.type === "Identifier") return returnsEffect(resolve(c), seen);
      // A semaphore's withPermits(n)(effect).
      return (
        c.type === "CallExpression" &&
        c.callee.type === "MemberExpression" &&
        c.callee.property.type === "Identifier" &&
        c.callee.property.name === "withPermits"
      );
    };
    /** A door that only picks the handler (one union in, one handler per kind): every branch returns a call to a function
     * traced under the method's own name, so the span is opened there. */
    const dispatches = (fn: Node, expected: string): boolean => {
      const returned = returnedBy(fn);
      return (
        returned.length > 0 &&
        returned.every((r) => {
          if (r.type !== "CallExpression" || r.callee.type !== "Identifier") return false;
          const traced = tracedAs(resolve(r.callee));
          return traced !== undefined && traced !== "untraced" && traced.name === expected;
        })
      );
    };
    const returnsEffect = (fn: Node, seen: Set<Node>): boolean => {
      if (seen.has(fn)) return false;
      seen.add(fn);
      if (tracedAs(fn) !== undefined) return true;
      return isFunction(fn) && returnedBy(fn).some((r) => isEffect(r, seen));
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.parent.type !== "VariableDeclaration" || node.parent.kind !== "const") return;
        consts.set(node.id.name, consts.has(node.id.name) ? undefined : (node.init ?? undefined));
      },
      FunctionDeclaration(node) {
        if (node.id) consts.set(node.id.name, consts.has(node.id.name) ? undefined : node);
      },
      ReturnStatement(node) {
        let at: Node = node.parent;
        while (!isFunction(at) && at.type !== "Program") at = at.parent;
        if (node.argument) returns.set(at, [...(returns.get(at) ?? []), node.argument]);
      },
      CallExpression(node) {
        const c = node.callee;
        const [object, ...rest] = node.arguments;
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          /^[A-Z]/u.test(c.object.name) &&
          c.property.type === "Identifier" &&
          c.property.name === "of" &&
          object?.type === "ObjectExpression" &&
          rest.length === 0
        )
          services.push({ service: c.object.name, object });
      },
      "Program:exit"() {
        for (const { service, object } of services)
          for (const p of object.properties) {
            if (p.type !== "Property" || p.computed) continue;
            const method = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
            if (method === undefined) continue;
            const value = resolve(p.value);
            const traced = tracedAs(value);
            const data = { service, method };
            if (traced === "untraced") continue;
            if (traced !== undefined) {
              const expected = `${service}.${method}`;
              if (traced.name !== expected)
                context.report({ node: traced.at, messageId: "name", data: { ...data, given: traced.name === undefined ? "nothing" : `"${traced.name}"` } });
            } else if (isFunction(value) && returnsEffect(value, new Set()) && !dispatches(value, `${service}.${method}`))
              context.report({ node: p, messageId: "unnamed", data });
          }
      },
    };
  },
});

const isContextService = (n: Node): boolean => {
  if (n.type === "CallExpression") return isContextService(n.callee);
  return (
    n.type === "MemberExpression" &&
    n.object.type === "Identifier" &&
    n.object.name === "Context" &&
    n.property.type === "Identifier" &&
    n.property.name === "Service"
  );
};

/** Words that end in s and still name one thing; a service named for one of them is singular. */
const singularInS = new Set(["Status", "Alias", "Canvas", "Lens", "Progress", "Access", "Address", "Ingress"]);
const lastWord = (name: string) => /[A-Z][a-z0-9]*$/u.exec(name)?.[0] ?? name;
const looksPlural = (name: string) => name.endsWith("s") && !singularInS.has(lastWord(name));

const singularService = defineRule({
  meta: {
    messages: {
      plural: says(
        "the service {{name}} has a plural name, but a service is one thing: the one that manages its concept",
        "name it with the concept's singular word, the same as its module folder and table (`class {{singular}} extends Context.Service<{{singular}}, …>`); a protocol shape that would clash is read as `T.X` through `import type * as T`",
        "docs/style/naming.md",
      ),
    },
  },
  create(context) {
    return {
      ClassDeclaration(node) {
        if (!node.id || !node.superClass || !isContextService(node.superClass) || !looksPlural(node.id.name)) return;
        context.report({
          node: node.id,
          messageId: "plural",
          data: { name: node.id.name, singular: node.id.name.replace(/(ies|s)$/u, (e) => (e === "ies" ? "y" : "")) },
        });
      },
    };
  },
});

/** The server's service classes, read once when the plugin loads. */
const serviceNames = new Set(
  globSync("apps/server/src/**/*.ts", { cwd: repo })
    .filter((f) => !f.endsWith(".test.ts"))
    .flatMap((f) => [...readFileSync(resolve(repo, f), "utf8").matchAll(/^export class (\w+) extends Context\.Service\b/gmu)].map((m) => m[1] ?? "")),
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

const isTaggedErrorCallee = (n: ESTree.Node): boolean =>
  (n.type === "Identifier" && n.name === "TaggedError") ||
  (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" && n.property.name === "TaggedError");

const taggedErrorTagArg = (superClass: ESTree.Expression): { found: true; tag: ESTree.Node | undefined } | { found: false } => {
  if (superClass.type !== "CallExpression") return { found: false };
  if (isTaggedErrorCallee(superClass.callee)) return { found: true, tag: superClass.arguments[0] };
  if (superClass.callee.type === "CallExpression" && isTaggedErrorCallee(superClass.callee.callee)) return { found: true, tag: superClass.arguments[0] };
  return { found: false };
};

const taggedErrorTag = defineRule({
  meta: {
    messages: {
      mismatch: says(
        '{{name}}\'s _tag is "{{tag}}", so catchTag("{{name}}") misses it and two error classes can silently share one tag',
        'name the _tag literal after the class ("{{name}}")',
        ".agents/skills/vv-effect/references/cases.md",
      ),
      dynamic: says(
        "a TaggedError needs a class name and a string literal _tag so TypeScript and whole-repo checks can see every tag statically",
        'give the class a name and pass the matching string literal _tag ("ClassName")',
        ".agents/skills/vv-effect/references/cases.md",
      ),
    },
  },
  create(context) {
    const checkClass = (node: ESTree.Class) => {
      if (!node.superClass) return;
      const hit = taggedErrorTagArg(node.superClass);
      if (!hit.found) return;
      if (!node.id || !hit.tag || hit.tag.type !== "Literal" || typeof hit.tag.value !== "string") {
        context.report({ node: hit.tag ?? node.superClass, messageId: "dynamic" });
        return;
      }
      if (hit.tag.value !== node.id.name) {
        context.report({ node: hit.tag, messageId: "mismatch", data: { name: node.id.name, tag: hit.tag.value } });
      }
    };
    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});

const isUnshadowedBinding = (node: ESTree.IdentifierReference, context: Context): boolean => {
  for (let scope: Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const def = scope.set.get(node.name)?.defs[0];
    if (!def) continue;
    return def.type === "ImportBinding";
  }
  return true;
};

const matchBranchMethods = new Set([
  "when",
  "whenOr",
  "whenAnd",
  "tag",
  "tags",
  "tagsExhaustive",
  "not",
  "discriminator",
  "discriminators",
  "discriminatorStartsWith",
]);

const collectionSchemaMethods = new Set(["Array", "ReadonlyArray", "NonEmptyArray", "ReadonlySet", "HashSet", "ReadonlyMap", "HashMap"]);

const returnedExpr = (fn: ESTree.ArrowFunctionExpression | ESTree.Function): ESTree.Expression | undefined => {
  if (fn.body === null) return undefined;
  if (fn.body.type !== "BlockStatement") return fn.body;
  if (fn.body.body.length === 1 && fn.body.body[0]?.type === "ReturnStatement") return fn.body.body[0].argument ?? undefined;
  return undefined;
};

const effectIdioms = defineRule({
  meta: {
    messages: {
      noFlow: says(
        "flow composes functions point-free, which drops generic type parameters and hides extra callback arguments",
        "write an explicit function `(x) => ...` or start with a concrete value in `pipe(x, ...)`",
        ".agents/skills/vv-effect/references/cases.md",
      ),
      tacitMap: says(
        "passing a function reference directly to data-last Effect.map erases generic parameters and silently forwards unexpected arguments",
        "write an explicit arrow callback `Effect.map((x) => fn(x))` or data-first `Effect.map(effect, fn)`",
        ".agents/skills/vv-effect/references/cases.md",
      ),
      matchReturnTypeLate: says(
        "Match.withReturnType placed after branch matchers cannot constrain earlier branches, so the wrong branch reports a cryptic union mismatch downstream",
        "put `Match.withReturnType<Out>()` before the first `Match.when` / `Match.tag` / `Match.not` step",
        ".agents/skills/vv-effect/references/cases.md",
      ),
      configNumber: says(
        "Config.Number accepts NaN, Infinity, and floats where ports, counts, and milliseconds expect a bounded integer or finite number",
        "use `Config.Int`, `Config.Port`, `Config.Finite`, or `Config.schema(...)`",
        ".agents/skills/vv-effect/references/cases.md",
      ),
      configOrElseDefault: says(
        "Config.orElse(() => Config.succeed(...)) hides malformed configuration values under the fallback default",
        "use `Config.withDefault(config, fallback)` so missing keys use the default while invalid values still fail",
        ".agents/skills/vv-effect/references/cases.md",
      ),
      decodeToDouble: says(
        "Schema.decodeTo onto another collection schema decodes every element a second time after the source collection already decoded them",
        "wrap the target schema in `Schema.toType(...)` so element decoding runs only once",
        ".agents/skills/vv-effect/references/cases.md",
      ),
    },
  },
  create(context) {
    const effectNames = new Set(["Effect"]);
    const configNames = new Set(["Config"]);
    const matchNames = new Set(["Match"]);
    const schemaNames = new Set(["Schema"]);

    const memberMethod = (n: ESTree.Node | undefined, owners: ReadonlySet<string>): string | undefined => {
      if (!n || n.type !== "MemberExpression" || n.computed || n.property.type !== "Identifier") return undefined;
      if (n.object.type !== "Identifier" || !owners.has(n.object.name) || !isUnshadowedBinding(n.object, context)) return undefined;
      return n.property.name;
    };

    const callMethod = (n: ESTree.Node | undefined, owners: ReadonlySet<string>): string | undefined =>
      n?.type === "CallExpression" ? memberMethod(n.callee, owners) : undefined;

    const matchStepMethod = (n: ESTree.Node): string | undefined => {
      let cur: ESTree.Node = n;
      while (cur.type === "CallExpression") cur = cur.callee;
      return memberMethod(cur, matchNames);
    };

    const hasMatchBranch = (n: ESTree.Node): boolean => {
      const m = matchStepMethod(n);
      if (m !== undefined && matchBranchMethods.has(m)) return true;
      if (n.type !== "CallExpression") return false;
      if (n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.type === "Identifier" && n.callee.property.name === "pipe") {
        return hasMatchBranch(n.callee.object) || n.arguments.some((arg) => arg.type !== "SpreadElement" && hasMatchBranch(arg));
      }
      if (n.callee.type === "Identifier" && n.callee.name === "pipe") {
        return n.arguments.some((arg) => arg.type !== "SpreadElement" && hasMatchBranch(arg));
      }
      return false;
    };

    const isCollectionSchemaCall = (n: ESTree.Node | undefined): boolean => {
      const m = callMethod(n, schemaNames);
      return m !== undefined && collectionSchemaMethods.has(m);
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const src = node.source.value;
        if (src === "effect" || src === "effect/Function") {
          for (const s of node.specifiers) {
            if (s.type !== "ImportSpecifier" || s.importKind === "type") continue;
            const imported = s.imported.type === "Identifier" ? s.imported.name : s.imported.value;
            if (imported === "flow") context.report({ node: s, messageId: "noFlow" });
            if (src === "effect") {
              if (imported === "Effect") effectNames.add(s.local.name);
              if (imported === "Config") configNames.add(s.local.name);
              if (imported === "Match") matchNames.add(s.local.name);
              if (imported === "Schema") schemaNames.add(s.local.name);
            }
          }
        }
        for (const s of node.specifiers) {
          if (s.type !== "ImportNamespaceSpecifier") continue;
          if (src === "effect/Effect") effectNames.add(s.local.name);
          if (src === "effect/Config") configNames.add(s.local.name);
          if (src === "effect/Match") matchNames.add(s.local.name);
          if (src === "effect/Schema") schemaNames.add(s.local.name);
        }
      },
      CallExpression(node) {
        if (callMethod(node, effectNames) === "map" && node.arguments.length === 1) {
          const [arg] = node.arguments;
          if (arg && (arg.type === "Identifier" || arg.type === "MemberExpression")) {
            context.report({ node: arg, messageId: "tacitMap" });
          }
        }

        if (callMethod(node, configNames) === "Number") {
          context.report({ node, messageId: "configNumber" });
        }

        if (callMethod(node, configNames) === "orElse") {
          const cb = node.arguments.length === 2 ? node.arguments[1] : node.arguments[0];
          if (cb && (cb.type === "ArrowFunctionExpression" || cb.type === "FunctionExpression")) {
            const ret = returnedExpr(cb);
            if (callMethod(ret, configNames) === "succeed") {
              context.report({ node, messageId: "configOrElseDefault" });
            }
          }
        }

        if (callMethod(node, schemaNames) === "decodeTo" && node.arguments.length >= 2) {
          const [from, to] = node.arguments;
          if (from && to && from.type !== "SpreadElement" && to.type !== "SpreadElement" && isCollectionSchemaCall(from) && isCollectionSchemaCall(to)) {
            context.report({ node, messageId: "decodeToDouble" });
          }
        }

        const pipePair =
          node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier" && node.callee.property.name === "pipe"
            ? { head: node.callee.object, tail: node.arguments }
            : node.callee.type === "Identifier" && node.callee.name === "pipe" && node.arguments.length >= 2 && node.arguments[0]?.type !== "SpreadElement"
              ? { head: node.arguments[0], tail: node.arguments.slice(1) }
              : undefined;

        if (pipePair?.head !== undefined) {
          let sawBranch = hasMatchBranch(pipePair.head);
          for (const step of pipePair.tail) {
            if (step.type === "SpreadElement") continue;
            const m = matchStepMethod(step);
            if (m === "withReturnType" && sawBranch) context.report({ node: step, messageId: "matchReturnTypeLate" });
            if (m !== undefined && matchBranchMethods.has(m)) sawBranch = true;
          }

          if (isCollectionSchemaCall(pipePair.head)) {
            for (const step of pipePair.tail) {
              if (step.type === "SpreadElement") continue;
              if (callMethod(step, schemaNames) === "decodeTo") {
                const target = step.type === "CallExpression" ? step.arguments[0] : undefined;
                if (target && target.type !== "SpreadElement" && isCollectionSchemaCall(target)) {
                  context.report({ node: step, messageId: "decodeToDouble" });
                }
              }
            }
          }
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
    "stylex-only": stylexOnly,
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
    "clock-in-effect": clockInEffect,
    "scoped-fibers": scopedFibers,
    "yield-in-loop": yieldInLoop,
    "atom-door": atomDoor,
    "unstable-effect-door": unstableEffectDoor,
    "page-store": pageStore,
    "stored-door": storedDoor,
    "act-door": actDoor,
    "failure-tone": failureTone,
    "promise-boundary": promiseBoundary,
    "try-promise-catch": tryPromiseCatch,
    "one-absent": oneAbsent,
    "global-doors": globalDoors,
    "native-control": nativeControl,
    "no-instanceof-tagged": noInstanceofTagged,
    "no-object-guard": noObjectGuard,
    "service-method-names": serviceMethodNames,
    "singular-service": singularService,
    "protocol-namespace": protocolNamespace,
    "tagged-error-tag": taggedErrorTag,
    "effect-idioms": effectIdioms,
  },
});
