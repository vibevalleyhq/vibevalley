/**
 * The repository's own lint rules, loaded by vite.config.ts's lint.jsPlugins.
 *
 *   no-wall-clock: in the server, time is read and waited on through Effect's Clock (or the Time a class was handed,
 *   infra/time.ts), so that a test's TestClock moves all of it. Date.now(), new Date() with no arguments, setTimeout and
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
 *   page-layers: the page (apps/web/src) is in layers, each importing only those before it: base (pure ground), infra
 *   (the server, the host, the browser), state (the middle layer), ui, ui/pixel, the features (features/<concept>), the
 *   skins (farm, tree), app. A feature uses another only through its index.ts, so
 *   what is inside it can change; the features' graph has no cycle (layers.test.ts). docs/subsystems/app.md says why.
 *
 *   promise-boundary: the server is Effect; a Promise is only the one call into an outside library, made inside
 *   Effect.tryPromise or Effect.promise (docs/subsystems/foundation.md, "Promise 只在外面的库的一次调用上"). An async
 *   function or a new Promise anywhere else is a loop, a wait or a queue written by hand. The async function such a
 *   wrapper is given holds at most one await: a second is a step that the first one's result decides, so the checks,
 *   branches and errors between them sit where interruption and typed errors do not reach. Counting awaits is the whole
 *   test; a body with one await and logic around it passes, and is the reviewer's to see. Where a library's own
 *   interface is Promises (oar's runtimes, the MCP SDK's handlers), vite.config.ts turns the rule off for that file and
 *   says why.
 *
 *   try-promise-catch: Effect.tryPromise is given { try, catch }, never a bare function. Given only the function, a
 *   rejection becomes Cause.UnknownError, whose message says nothing of what went wrong; catch makes it the module's
 *   own error from the real one.
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
 *   atom-door: the page's middle layer stands on Effect's Atom (effect/reactivity), whose API is marked unstable; only
 *   apps/web/src/state imports it (atom.ts, intent.ts), and features read atoms through what state exports, so a change in
 *   Atom is fixed in one folder. An import of effect/reactivity anywhere else under apps/web/src is reported, a type-only
 *   one too: a type names the API as much as a call does; vite.config.ts says where the rule runs.
 *
 *   page-store: a value the page keeps for its life (a dialog opened from two places, the farm's overlays, a draft) is
 *   an atom of the page's, made with state/'s helpers (defineAtom; defineStored for one kept on the machine), so it is
 *   kept one way: read in Solid, heard by plain code, reset by a test. A createSignal or createStore made outside any
 *   function, in apps/web/src/features, farm or ui, is reported; one made in a component or a function is its own.
 *
 *   stored-door: the browser's storage is reached only through state/stored.ts (defineStored), which decodes what it
 *   reads with a Schema, survives a storage that throws, keeps every key under one namespace and tells every reader of a
 *   change, this tab's and the others'. localStorage or sessionStorage named anywhere else under apps/web/src is reported.
 *
 *   act-door: what the owner does on the page goes through its middle layer: an Act (apps/web/src/ui/act.ts: busy until
 *   it ends, a refusal in the error tone, nothing sent while the state stream is lost) or an intent (state/intent.ts, a
 *   change shown before the server has it). In a component (a .tsx under features/ or farm/) a call of the API client
 *   that changes something is reported unless it is made inside a function handed to some `x.run(…)`, an Act's. A call
 *   changes something unless its method is a read: list, get, search, recall, validate or preview… (the client's verbs,
 *   packages/protocol/src/client.ts). An intent's send is written in the feature's .ts, where the rule does not look.
 *
 *   failure-tone: a refusal is said in the error tone. toast(…) given a reason (reasonOf) without "bad" as its tone, and
 *   the pixel toasts.add({ … }) given one without the error type, are reported; ui/act.ts says refusals so already.
 *
 *   db-door: the server reaches the database through the Db service (apps/server/src/infra/db.ts), which says what a
 *   failed query becomes: run and inTx make it a defect, attempt and attemptTx keep it for a caller that tells or retries
 *   it. A module that takes the SqlClient itself, or opens its own withTransaction, decides that again by hand, and
 *   the usual way back is to die and catchDefect the SqlError. A type-only import (a query's SqlClient requirement in a
 *   signature) touches no client and is not reported; vite.config.ts says where the rule runs.
 *
 *   parent-import: in an app's src (apps/web/src, apps/server/src) an import that climbs out of its folder is written
 *   from src, as @/x/y (the app's tsconfig.json paths), not ../../x/y: the same file reads the same from everywhere,
 *   and moving a file does not change what its imports say. Siblings and children stay ./x.
 *
 *   no-instanceof-tagged: an expected error is told apart by its _tag (Predicate.isTagged, catchTag), not by its class.
 *   instanceof narrows nothing in an error channel typed unknown, and it is how a function that sorts errors ends up
 *   taking unknown instead of the union its callers pass. Seen syntactically: x instanceof Y is reported when Y is a
 *   class declared at the top of the same file extending something written TaggedError (Data.TaggedError,
 *   Schema.TaggedError), or when Y's name ends in Error, Failed, Failure or Refused and is not one of JavaScript's own
 *   errors. A tagged class imported under another kind of name is not seen, and a plain Error subclass named that way
 *   is reported (rename it or make it tagged).
 *
 *   no-object-guard: typeof x === "object" && x !== null (either order, in any && chain) is Effect's Predicate.isObject
 *   written again, and the start of a hand-written decoder; Predicate.isObject, Predicate.hasProperty or a Schema say
 *   it once. The rule compares the two operands' text, so x and (x) are different things to it.
 *
 *   service-method-names: a server service's method that returns an Effect is Effect.fn("X.m") (X the service, m the
 *   member), so the OTLP traces show each call under the name it is called by, or Effect.fnUntraced on a hot path or a
 *   thin accessor. Inside X.of({ … }), a member that is a function, written there or a const of the same file, is
 *   reported when the syntax shows it returns an Effect: what it returns is a call of one of Effect's own functions, a
 *   pipe through them, a semaphore's withPermits, a call of a local function that does, or a ?: or ?? with one of those
 *   on a side. An Effect.fn whose name is not "X.m" is reported too. It cannot see past the file: a member that only
 *   calls something destructured (const { run } = yield* Db) or imported, a member taken from another object
 *   (blocks.markdown), and a name declared twice in the file are skipped, as are members that are an Effect or a Stream
 *   themselves; a function that returns a Stream, a Promise or a plain value is never reported.
 *
 *   singular-service: a server service takes its concept's singular word, the same as its module folder and table
 *   (Issue, Session), as Effect's own Database does; a plural says "many", and the service is one. A class extending
 *   Context.Service whose name ends in s is reported unless its last word is one of the singular words listed with the
 *   rule (Status, Progress …).
 *
 *   protocol-namespace: a protocol shape named like a server service (Issue, Session) is read as T.Issue through
 *   import type * as T from "@vibevalley/protocol", so the service keeps the bare name in every file. The service names
 *   are read from apps/server/src when the plugin loads; a named import of one of them from the protocol is reported.
 */

import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { definePlugin, defineRule, type ESTree } from "vite-plus/lint/plugins";

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
        "apps/server/src/infra/time.ts",
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
const pageLayers = ["base", "infra", "state", "ui", "ui/pixel", "features", "skin", "app", "root"] as const;

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
        "{{from}} is before {{to}} in the page's layers (base, infra, state, ui, ui/pixel, features, farm and tree, app), and a layer imports only its own and those before it",
        "move what both need down into a layer before {{from}} (a pure function to base, a talk with the outside to infra, a component to ui), or have {{to}} pass it in as a prop",
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
      steps: says(
        "this async function awaits more than once inside Effect.tryPromise or Effect.promise, so the steps between its awaits (checks, branches, errors) run where interruption and typed errors do not reach",
        "keep one library call per wrapper and write the steps in the Effect around them: `const a = yield* Effect.tryPromise({ try: () => lib.first(…), catch })`, check `a` there (`return yield* Effect.fail(…)`), then `yield* Effect.tryPromise({ try: () => lib.next(a), catch })`",
        "apps/server/src/tool/tool.ts",
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
        "`useTimeout()` or `useInterval(fn, ms)` from `@/base/timer` in a component; in an effect, keep the handle and return `() => clearTimeout(t)`; a store that lives as long as the page keeps the handle too, or says why it need not with a disable comment",
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
        "git through `apps/server/src/project/git.ts` (tests: `gitSync`, `gitIn` in `apps/server/src/testing/git.ts`), a helper's command through `runtime/dsh.ts`; a new kind of process gets its own door, added to the list in vite.config.ts",
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
        // A property named so on some other object (`x.localStorage` off window or globalThis still counts) or a key.
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

/** api.a.b.verb(…): the verb, when the chain starts at the identifier `api`. */
function apiVerb(callee: ESTree.Node): string | undefined {
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return undefined;
  let at: ESTree.Node = callee.object;
  while (at.type === "MemberExpression") at = at.object;
  return at.type === "Identifier" && at.name === "api" ? callee.property.name : undefined;
}

/** A call x.run(…) given `fn` among its arguments. */
const isRunOf = (call: unknown, fn: object): boolean => {
  if (typeof call !== "object" || call === null || !("type" in call) || call.type !== "CallExpression") return false;
  if (!("arguments" in call) || !Array.isArray(call.arguments) || !call.arguments.includes(fn) || !("callee" in call)) return false;
  const callee = call.callee;
  if (typeof callee !== "object" || callee === null || !("type" in callee) || callee.type !== "MemberExpression" || !("property" in callee)) return false;
  const property = callee.property;
  return typeof property === "object" && property !== null && "name" in property && property.name === "run";
};

/** Some function around the node is handed to x.run(…). */
function insideRun(node: { parent?: unknown }): boolean {
  for (let owner = ownerOf(node); owner; owner = ownerOf(owner.fn)) if (isRunOf(owner.parent, owner.fn)) return true;
  return false;
}

const actDoor = defineRule({
  meta: {
    messages: {
      act: says(
        "`api.{{call}}` changes something on the server straight from a component: it has no busy, no refusal in the error tone, and goes out while the state stream is lost",
        "hand it to an Act (`const act = createAct()` from ui/act.ts, `createPixelAct()` in a skin; `act.run(() => api.{{call}}(…))`), or, when the page shows the change before the server has it, send it through an intent defined in the feature's .ts (`defineIntent`, state/intent.ts) with an overlay of its own",
        "apps/web/src/ui/act.ts",
      ),
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const verb = apiVerb(node.callee);
        if (verb === undefined || readVerbs.has(verb) || verb.startsWith("preview") || insideRun(node)) return;
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

/** JavaScript's own errors: plain classes, never tagged. */
const nativeErrors = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "DOMException"]);
const taggedName = /(?:Error|Failed|Failure|Refused)$/u;

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
    /** Whether the syntax shows an Effect: one of Effect's makers, a pipe through Effect's combinators, a semaphore's
     * withPermits, a call of a local function that returns one, or a conditional or ?? with one on either side. */
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
            } else if (isFunction(value) && returnsEffect(value, new Set())) context.report({ node: p, messageId: "unnamed", data });
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
const singularInS = new Set(["Status", "Alias", "Canvas", "Lens", "Progress", "Access", "Address"]);
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
    "child-process-door": childProcessDoor,
    "dropped-timer": droppedTimer,
    "sync-fs": syncFs,
    "atom-door": atomDoor,
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
  },
});
