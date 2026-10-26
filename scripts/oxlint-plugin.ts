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
 *   no-cjk-literal: what is said to the owner is in a word table, in Chinese and in English (words.ts, a words/ folder;
 *   @vibevalley/protocol/words), and what is said to a model in a prompts.ts; vite.config.ts turns the rule off for
 *   those files and the tests. A string, a template or JSX text with a Chinese character anywhere else is a word left
 *   out of the tables. A regular expression is not: it reads what people and models write.
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

const han = /\p{Script=Han}/u;

const noCjkLiteral = defineRule({
  meta: {
    messages: {
      cjk: "words for the owner go in a word table (words.ts, with their English), words for a model in a prompts.ts (@vibevalley/protocol/words)",
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

export default definePlugin({
  meta: { name: "vibevalley" },
  rules: { "no-wall-clock": noWallClock, "no-test-sleep": noTestSleep, "no-comment-divider": noCommentDivider, "no-cjk-literal": noCjkLiteral },
});
