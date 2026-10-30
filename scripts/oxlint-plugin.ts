/**
 * The repository's own lint rules, loaded by vite.config.ts's lint.jsPlugins.
 *
 *   no-wall-clock: in the server, time is read and waited on through Effect's Clock (or the Time a class was handed,
 *   base/time.ts), so that a test's TestClock moves all of it. Date.now(), new Date() with no arguments, setTimeout and
 *   setInterval read or wait on the wall clock behind its back.
 *
 *   no-test-sleep: a test does not wait by the clock. What it waits for in the background it asks after with until or
 *   whenState (apps/server/src/testing/until.ts), a window is moved through with TestClock, and a fake that should take
 *   a while is held until the test lets it go (testing/helper.ts's releaseHeld). setTimeout, setInterval, Effect.sleep
 *   and Playwright's waitForTimeout in a test are a guess at how long something takes: slow when it is quick, flaky when
 *   it is slow.
 *
 *   no-comment-divider: a comment does not title or fence off a stretch of code (docs/style/code.md). Only the divider
 *   is recognised (a run of ─ ━ ═, or a comment of nothing but -=*#~_/); the comments a pattern cannot judge are
 *   scripts/comment-review.ts's.
 *
 *   no-cjk-literal: what is said to the owner is in the catalogs, in Chinese and in English (packages/i18n/locales,
 *   read as t("key")), and what is said to a model in a prompts.ts; vite.config.ts turns the rule off for those files
 *   and the tests. A string, a template or JSX text with a Chinese character anywhere else is a word left out of the
 *   catalogs; so is Chinese punctuation joining words in code (list() joins a list). A regular expression is not: it
 *   reads what people and models write.
 *
 *   no-hex-color: the workbench's colours are the palette's in apps/web/src/style.css, named by what they are for, so
 *   they follow the theme (设置 › 外观); a colour written into a class (bg-[#…]) would stay as it is. The pixel skin and
 *   the avatars are drawn and keep theirs; vite.config.ts says where the rule runs.
 *
 *   no-copy-selector: a page test finds what it clicks and reads by data-testid and state attributes, not by the
 *   interface's words (getByText, getByRole's name, toHaveText…): words are the catalogs' to check, and a test that
 *   reads them breaks on every rewording. vite.config.ts says where it runs.
 *
 *   design-tokens: the workbench's corners, type sizes, motion, layers, disabled look and shadows are on the ladders of
 *   docs/style/design.md (scripts/design-tokens.ts says which classes are off them); the pixel skin and the avatars are
 *   drawn and keep their own values.
 *
 *   native-control: the workbench's choosers are its own (ui/Field.tsx's Select, ui/Checkbox.tsx, base-ui's RadioGroup
 *   and Slider): a native <select>, checkbox, radio or range is drawn by the system, so it looks different on every
 *   machine and stays light in the dark theme. vite.config.ts says where it runs; the pixel skin draws its own.
 *
 *   page-layers: the page (apps/web/src) is in layers, each importing only those before it: base, ui, ui/pixel, the
 *   features (features/<concept>), the skins (farm, tree), app. A feature uses another only through its index.ts, so
 *   what is inside it can change; the features' graph has no cycle (layers.test.ts). docs/subsystems/app.md says why.
 *
 *   promise-boundary: the server is Effect; a Promise is only the one call into an outside library, made inside
 *   Effect.tryPromise or Effect.promise (docs/subsystems/foundation.md, "Promise 只在外面的库的一次调用上"). An async
 *   function or a new Promise anywhere else is a loop, a wait or a queue written by hand. Where a library's own interface
 *   is Promises (oar's runtimes, the MCP SDK's handlers), vite.config.ts turns the rule off for that file and says why.
 *
 *   one-absent: a type that admits null and undefined at once carries two words for one thing. Outside's null is taken in
 *   at the door (docs/style/code.md, "没有值"); vite.config.ts says where a door is.
 *
 *   parent-import: in an app's src (apps/web/src, apps/server/src) an import that climbs out of its folder is written
 *   from src, as @/x/y (the app's tsconfig.json paths), not ../../x/y: the same file reads the same from everywhere,
 *   and moving a file does not change what its imports say. Siblings and children stay ./x.
 */

import { definePlugin, defineRule } from "vite-plus/lint/plugins";
import { hexClass, offTokens, tokenAdvice, type TokenKind } from "./design-tokens.ts";

const message = "time comes from Effect's Clock, or the Time a class was handed (apps/server/src/base/time.ts), so tests can move it";

const noWallClock = defineRule({
  meta: { messages: { wallClock: message } },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          c.object.name === "Date" &&
          c.property.type === "Identifier" &&
          c.property.name === "now"
        )
          context.report({ node, messageId: "wallClock" });
        else if (c.type === "Identifier" && (c.name === "setTimeout" || c.name === "setInterval")) context.report({ node, messageId: "wallClock" });
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) context.report({ node, messageId: "wallClock" });
      },
    };
  },
});

const noTestSleep = defineRule({
  meta: {
    messages: {
      sleep:
        "a test does not wait by the clock: ask after what it waits for (until, whenState), move a window with TestClock, or hold a fake until the test lets it go",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type === "Identifier" && (c.name === "setTimeout" || c.name === "setInterval")) context.report({ node, messageId: "sleep" });
        else if (
          c.type === "MemberExpression" &&
          c.property.type === "Identifier" &&
          (c.property.name === "waitForTimeout" || (c.property.name === "sleep" && c.object.type === "Identifier" && c.object.name === "Effect"))
        )
          context.report({ node, messageId: "sleep" });
      },
    };
  },
});

const noCommentDivider = defineRule({
  meta: { messages: { divider: "a comment does not title or fence off code (docs/style/code.md): say why where it is not obvious, or nothing" } },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments())
          if (/[─━═]{2}/.test(comment.value) || /^[-=*#~_/\s]{4,}$/.test(comment.value.trim())) context.report({ loc: comment.loc, messageId: "divider" });
      },
    };
  },
});

/** Where a page test names what it looks for or what it expects to read. */
const textArg = new Set(["getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByAltText", "toHaveText", "toContainText"]);

/** Options that name the words: getByRole's name, filter's and locator's hasText. */
const textOption = new Set(["name", "hasText", "hasNotText"]);

type ObjectProperty = { type: string; key?: { type: string; name?: string }; value?: Parameters<typeof chineseLiteral>[0] };

/** A literal with Chinese in it: a string, a template, or a regular expression's pattern. */
const chineseLiteral = (node: { type: string; value?: unknown; regex?: { pattern: string }; quasis?: { value: { raw: string } }[] } | undefined) =>
  !!node &&
  ((node.type === "Literal" && typeof node.value === "string" && han.test(node.value)) ||
    (node.type === "Literal" && node.regex !== undefined && han.test(node.regex.pattern)) ||
    (node.type === "TemplateLiteral" && (node.quasis ?? []).some((q) => han.test(q.value.raw))));

const noCopySelector = defineRule({
  meta: {
    messages: {
      copy: "page tests find elements by data-testid and state attributes, and leave the words to the catalogs' checks (docs/subsystems/foundation.md): no interface words here; data the test made goes in a fixtures constant",
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

const noHexColor = defineRule({
  meta: {
    messages: {
      hex: "the workbench's colours are the palette's (apps/web/src/style.css: bg-ok-soft, text-warn-ink, bg-ink/20…), so they follow 设置 › 外观; add one there for a new purpose",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && hexClass.test(node.value)) context.report({ node, messageId: "hex" });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((q) => hexClass.test(q.value.cooked ?? q.value.raw))) context.report({ node, messageId: "hex" });
      },
    };
  },
});

const designTokens = defineRule({
  meta: {
    messages: Object.fromEntries(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tokenAdvice has one key per TokenKind and no more
      (Object.keys(tokenAdvice) as TokenKind[]).map((kind) => [kind, `off the workbench's ${kind} ladder (docs/style/design.md): use ${tokenAdvice[kind]}`]),
    ),
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string") for (const kind of new Set(offTokens(node.value))) context.report({ node, messageId: kind });
      },
      TemplateLiteral(node) {
        const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
        for (const kind of new Set(offTokens(text))) context.report({ node, messageId: kind });
      },
    };
  },
});

// Chinese punctuation too: a word joined to its neighbor with 「：」 or 「、」 in code reads as Chinese in an English farm.
const han = /[\p{Script=Han}、，。：；（）！？「」【】〔〕]/u;

const noCjkLiteral = defineRule({
  meta: {
    messages: {
      cjk: 'words for the owner go in the catalogs (packages/i18n/locales, with their English; t("key")), words for a model in a prompts.ts',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && han.test(node.value)) context.report({ node, messageId: "cjk" });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((q) => han.test(q.value.cooked ?? q.value.raw))) context.report({ node, messageId: "cjk" });
      },
      JSXText(node) {
        if (han.test(node.value)) context.report({ node, messageId: "cjk" });
      },
    };
  },
});

const nativeTypes = new Set(["checkbox", "radio", "range"]);

const nativeControl = defineRule({
  meta: {
    messages: {
      native: "the workbench draws its own choosers: ui/Field.tsx's Select, ui/Checkbox.tsx, base-ui's RadioGroup and Slider (docs/style/design.md)",
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
const pageLayers = ["base", "ui", "ui/pixel", "features", "skin", "app", "root"] as const;

function pageUnit(path: string): { layer: (typeof pageLayers)[number]; unit: string } {
  const parts = path.split("/");
  if (parts.length === 1) return { layer: "root", unit: "" };
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
      layer: "the page imports only from its own layer or one before it: base, ui, ui/pixel, features, farm and tree, app (apps/web/README.md)",
      index: "another feature is used through its index.ts (features/<concept>), not a file inside it (apps/web/README.md)",
    },
  },
  create(context) {
    const at = context.filename.replaceAll("\\", "/").split("/apps/web/src/")[1];
    if (at === undefined) return {};
    const from = pageUnit(at);
    const verdict = (spec: unknown): "layer" | "index" | undefined => {
      if (typeof spec !== "string" || !(spec.startsWith(".") || spec.startsWith("@/"))) return;
      const target = spec.startsWith("@/") ? spec.slice(2) : joinPath(at, spec);
      if (target.startsWith("..")) return;
      const to = pageUnit(target);
      if (to.unit === from.unit) return;
      const a = pageLayers.indexOf(from.layer);
      const b = pageLayers.indexOf(to.layer);
      if (b > a || (b === a && from.layer !== "features")) return "layer";
      if (to.layer === "features" && target !== to.unit && target !== `${to.unit}/index`) return "index";
      return undefined;
    };
    return {
      ImportDeclaration(node) {
        const messageId = verdict(node.source.value);
        if (messageId) context.report({ node, messageId });
      },
      ExportNamedDeclaration(node) {
        const messageId = verdict(node.source?.value);
        if (messageId) context.report({ node, messageId });
      },
      ExportAllDeclaration(node) {
        const messageId = verdict(node.source.value);
        if (messageId) context.report({ node, messageId });
      },
    };
  },
});

/** Effect.tryPromise(async …), Effect.tryPromise({ try: async … }) and Effect.promise(async …): the one place an async body is the boundary. */
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
      async:
        "the server is Effect: write this in Effect.gen, and keep the library's one call in Effect.tryPromise (scripts/oxlint-plugin.ts, promise-boundary)",
      promise: "the server is Effect: wait with Effect.callback, Deferred or Queue instead of a new Promise (scripts/oxlint-plugin.ts, promise-boundary)",
    },
  },
  create(context) {
    const check = (node: Parameters<typeof inEffectPromise>[0] & { async?: boolean }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- oxlint's ESTree node, typed loosely by its plugin API
      if (node.async === true && !inEffectPromise(node)) context.report({ node: node as never, messageId: "async" });
    };
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Promise") context.report({ node, messageId: "promise" });
      },
    };
  },
});

const oneAbsent = defineRule({
  meta: { messages: { both: "one word for none: undefined inside, null only at a door to the outside (docs/style/code.md, 没有值)" } },
  create(context) {
    return {
      TSUnionType(node) {
        const kinds = new Set(node.types.map((t) => t.type));
        if (kinds.has("TSNullKeyword") && kinds.has("TSUndefinedKeyword")) context.report({ node, messageId: "both" });
      },
    };
  },
});

const parentImportRule = defineRule({
  meta: {
    messages: { parent: "write an import from outside this folder as {{alias}} (scripts/oxlint-plugin.ts, parent-import)" },
  },
  create(context) {
    const [, app, at] = /\/apps\/(web|server)\/src\/(.+)$/.exec(context.filename.replaceAll("\\", "/")) ?? [];
    if (app === undefined || at === undefined) return {};
    const check = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>, spec: unknown) => {
      if (typeof spec !== "string" || !spec.startsWith("../")) return;
      const ups = spec.split("/").filter((p) => p === "..").length;
      // Out of src (the server's db/generated): no alias reaches it.
      if (ups >= at.split("/").length) return;
      const target = joinPath(at, spec);
      context.report({ node, messageId: "parent", data: { alias: `@/${target}` } });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => check(node, node.source.type === "Literal" ? node.source.value : undefined),
      ExportNamedDeclaration: (node) => check(node, node.source?.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
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
    "no-copy-selector": noCopySelector,
    "design-tokens": designTokens,
    "page-layers": pageLayersRule,
    "parent-import": parentImportRule,
    "promise-boundary": promiseBoundary,
    "one-absent": oneAbsent,
    "native-control": nativeControl,
  },
});
