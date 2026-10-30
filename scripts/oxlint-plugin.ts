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
 *   global-doors: a property on window or globalThis is a contract between two worlds (a page and its shell, a test and
 *   the program it drives). It is declared once, in a door file (declare global, interface Window), and then read and
 *   set with its type; TypeScript refuses one that is not declared. What gets around that is reported: casting window,
 *   globalThis or self, and Object.assign or Object.defineProperty onto them; declare global outside a door is too
 *   (vite.config.ts lists the doors).
 *
 *   db-door: the server reaches the database through the Db service (apps/server/src/base/db.ts), which says what a
 *   failed query becomes: run and inTx make it a defect, attempt and attemptTx keep it for a caller that tells or retries
 *   it. A module that takes the SqlClient itself, or opens its own withTransaction, decides that again by hand, and
 *   the usual way back is to die and catchDefect the SqlError. A type-only import (a query's SqlClient requirement in a
 *   signature) touches no client and is not reported; vite.config.ts says where the rule runs.
 *
 *   parent-import: in an app's src (apps/web/src, apps/server/src) an import that climbs out of its folder is written
 *   from src, as @/x/y (the app's tsconfig.json paths), not ../../x/y: the same file reads the same from everywhere,
 *   and moving a file does not change what its imports say. Siblings and children stay ./x.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { definePlugin, defineRule } from "vite-plus/lint/plugins";

import { hexClass, offTokens, tokenAdvice, type TokenKind } from "./design-tokens.ts";

/**
 * What a rule says when it fires, which is all an agent reads before its next try: what is wrong and why, what to write
 * instead, and a file in this repository that shows it (oxlint-plugin.test.ts checks the file is there). A message that
 * only says what is not allowed leaves the agent to guess, and a guess is often a way around the rule.
 */
export const says = (wrong: string, fix: string, see: string) => `${wrong}. Fix: ${fix}. See ${see}`;

const repo = resolve(import.meta.dirname, "..");

const noWallClock = defineRule({
  meta: {
    messages: {
      wallClock: says(
        "this reads or waits on the wall clock, which a test's TestClock cannot move",
        "in Effect code `yield* Clock.currentTimeMillis` to read and `Effect.sleep` to wait; in a class, the `Time` it was handed (`time.now()`, `time.sleep(ms)`)",
        "apps/server/src/base/time.ts",
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

const noHexColor = defineRule({
  meta: {
    messages: {
      hex: says(
        "a colour written into a class stays as it is when the theme changes (设置 › 外观)",
        "use the palette's name for what it is for (`bg-ok-soft`, `text-warn-ink`, `bg-ink/20`…); a new purpose gets a new name in style.css, in both themes",
        "apps/web/src/style.css",
      ),
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
      (Object.keys(tokenAdvice) as TokenKind[]).map((kind) => [
        kind,
        says(`this ${kind} is off the workbench's ladder, so it matches nothing beside it`, `use ${tokenAdvice[kind]}`, "docs/style/design.md"),
      ]),
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

/**
 * The catalog a file's words belong in: packages/i18n/locales/zh/<host>.<module>.json, the deepest that exists for the
 * file's place (apps/web/src/farm/phone/x.tsx: web.farm.phone, then web.farm, then web).
 */
export function catalogOf(filename: string): string {
  const at = /\/apps\/(server|web|desktop|mobile)\/(?:src\/)?(.*)$/u.exec(filename.replaceAll("\\", "/"));
  const host = at?.[1];
  const rest = at?.[2];
  if (host === undefined || rest === undefined) return "shared";
  const folders = rest
    .split("/")
    .slice(0, -1)
    .filter((f) => f !== "features");
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
      Literal(node) {
        if (typeof node.value === "string" && han.test(node.value)) context.report({ node, messageId: "cjk", data });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((q) => han.test(q.value.cooked ?? q.value.raw))) context.report({ node, messageId: "cjk", data });
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
      layer: says(
        "{{from}} is before {{to}} in the page's layers (base, ui, ui/pixel, features, farm and tree, app), and a layer imports only its own and those before it",
        "move what both need down into a layer before {{from}} (a pure function to base, a component to ui), or have {{to}} pass it in as a prop",
        "apps/web/README.md",
      ),
      index: says(
        "a file inside another feature is its own business, free to change",
        'import it from "@/{{unit}}", and export it from {{unit}}/index.ts if it is meant to be shared',
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
      if (typeof spec !== "string" || !(spec.startsWith(".") || spec.startsWith("@/"))) return;
      const target = spec.startsWith("@/") ? spec.slice(2) : joinPath(at, spec);
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
        '`const { run, attempt, one, inTx, attemptTx } = yield* Db` and pass the generated query to it (`run(q.x(…))`); a type in a signature is `import type { SqlClient } from "effect/sql"`',
        "apps/server/src/base/db.ts",
      ),
      transaction: says(
        "a withTransaction of its own leaves the database's failure for each module to turn into a defect or a refusal by hand",
        '`inTx(work)` when a failure is a bug, `attemptTx(work)` when it is told to the owner or retried (`.pipe(Effect.catchTag("SqlError", …))`)',
        "apps/server/src/base/db.ts",
      ),
    },
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("apps/server/src/base/db.ts")) return {};
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect/sql" || node.importKind === "type") return;
        for (const s of node.specifiers)
          if (s.type === "ImportSpecifier" && s.importKind !== "type" && s.imported.type === "Identifier" && s.imported.name === "SqlClient")
            context.report({ node: s, messageId: "client" });
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === "MemberExpression" && c.property.type === "Identifier" && c.property.name === "withTransaction")
          context.report({ node, messageId: "transaction" });
      },
    };
  },
});

const parentImportRule = defineRule({
  meta: {
    messages: {
      parent: says(
        "an import that climbs out of its folder reads differently from every file and changes when the file moves",
        "write it as `{{alias}}` (vp check --fix does it)",
        "apps/{{app}}/tsconfig.json",
      ),
    },
    fixable: "code",
  },
  create(context) {
    const [, app, at] = /\/apps\/(web|server)\/src\/(.+)$/u.exec(context.filename.replaceAll("\\", "/")) ?? [];
    if (app === undefined || at === undefined) return {};
    // The string itself is replaced, quotes kept, so the fix is the same for every kind of import.
    const check = (source: { type: string; value?: unknown; range: [number, number] } | null | undefined) => {
      if (source?.type !== "Literal" || typeof source.value !== "string" || !source.value.startsWith("../")) return;
      const spec = source.value;
      const ups = spec.split("/").filter((p) => p === "..").length;
      // Out of src (the server's db/generated): no alias reaches it.
      if (ups >= at.split("/").length) return;
      const alias = `@/${joinPath(at, spec)}`;
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
    "db-door": dbDoor,
    "promise-boundary": promiseBoundary,
    "one-absent": oneAbsent,
    "global-doors": globalDoors,
    "native-control": nativeControl,
  },
});
