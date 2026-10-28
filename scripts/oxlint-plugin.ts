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
 *   page-layers: the page (apps/web/src) is in layers, each importing only those before it: base, ui, ui/pixel, the
 *   features (features/<concept>), the skins (farm, tree), app. A feature uses another only through its index.ts, so
 *   what is inside it can change; the features' graph has no cycle (layers.test.ts). docs/subsystems/app.md says why.
 */

import { definePlugin, defineRule } from "vite-plus/lint/plugins";

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
        const [first] = node.arguments as unknown as Parameters<typeof chineseLiteral>[0][];
        if (textArg.has(name) && chineseLiteral(first)) context.report({ node, messageId: "copy" });
        for (const arg of node.arguments as unknown as { type: string; properties?: ObjectProperty[] }[])
          if (arg.type === "ObjectExpression")
            for (const p of arg.properties ?? [])
              if (p.type === "Property" && p.key?.type === "Identifier" && textOption.has(p.key.name ?? "") && chineseLiteral(p.value))
                context.report({ node, messageId: "copy" });
      },
    };
  },
});

/** A colour written into a class (bg-[#e3efd2], text-[#3f6427]/50). */
const hexClass = /-\[#[0-9a-fA-F]{3,8}\]/;

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
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const target = joinPath(at, spec);
      if (target.startsWith("..")) return;
      const to = pageUnit(target);
      if (to.unit === from.unit) return;
      const a = pageLayers.indexOf(from.layer);
      const b = pageLayers.indexOf(to.layer);
      if (b > a || (b === a && from.layer !== "features")) return "layer";
      if (to.layer === "features" && target !== to.unit && target !== `${to.unit}/index`) return "index";
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

export default definePlugin({
  meta: { name: "vibevalley" },
  rules: {
    "no-wall-clock": noWallClock,
    "no-test-sleep": noTestSleep,
    "no-comment-divider": noCommentDivider,
    "no-cjk-literal": noCjkLiteral,
    "no-hex-color": noHexColor,
    "no-copy-selector": noCopySelector,
    "page-layers": pageLayersRule,
  },
});
