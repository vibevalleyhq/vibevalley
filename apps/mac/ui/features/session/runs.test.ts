import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { SessionEvent } from "@vibevalley/protocol";

import { collapsedStepSummary, waterfallWidths } from "./runs";

const sumOf = (xs: readonly number[]) => xs.reduce((total, x) => total + x, 0);

function expectClose(actual: number | undefined, expected: number, tolerance = 1e-6) {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(tolerance);
}

test("waterfallWidths returns empty on non-positive room or empty durations", () => {
  expect(waterfallWidths([], 400)).toEqual([]);
  expect(waterfallWidths([100, 200], 0)).toEqual([]);
  expect(waterfallWidths([100, 200], -10)).toEqual([]);
});

test("waterfallWidths splits room evenly when all durations are zero or non-positive", () => {
  expect(waterfallWidths([0, 0, 0], 300)).toEqual([100, 100, 100]);
  expect(waterfallWidths([-5, 0], 200)).toEqual([100, 100]);
});

test("waterfallWidths preserves linear scaling for equal and mild duration ratios", () => {
  expect(waterfallWidths([5_000, 5_000], 400)).toEqual([200, 200]);

  const mild = waterfallWidths([10_000, 40_000, 30_000], 800);
  expectClose(mild[0], 100);
  expectClose(mild[1], 400);
  expectClose(mild[2], 300);
  expectClose(sumOf(mild), 800);
});

test("waterfallWidths dampens 11s vs 7h36m extreme ratio while preserving order and room sum", () => {
  const elevenSeconds = 11_000;
  const sevenHours = (7 * 60 + 36) * 60_000;
  const widths = waterfallWidths([elevenSeconds, sevenHours], 560);
  expect(widths.length).toBe(2);
  expect(widths[0]).toBeGreaterThanOrEqual(44);
  expect(widths[1]).toBeGreaterThan(widths[0]);
  expectClose(sumOf(widths), 560);

  const withZero = waterfallWidths([0, elevenSeconds, sevenHours], 560);
  expect(withZero[0]).toBe(0);
  expect(withZero[1]).toBeGreaterThanOrEqual(44);
  expect(withZero[2]).toBeGreaterThan(withZero[1]);
  expectClose(sumOf(withZero), 560);

  const tight = waterfallWidths([1_000, 1_000_000], 60);
  expect(tight[0]).toBeGreaterThanOrEqual(30);
  expectClose(sumOf(tight), 60);
});

function userStep(text: string): SessionEvent {
  return { seq: 1, type: "user/message", text, time: 1_000, revision: 1 };
}

test("collapsedStepSummary strips internal orchestrator prompt scaffolding while preserving trigger meaning", () => {
  setLocale("zh");

  const userPrompt = [
    "【现在】2026-11-26 21:00",
    "【现状】",
    "用户的语言：zh（你说的话、写给用户和帮工的都用它）",
    "仓库（工作目录 /var/folders/xx/work 下的文件夹）：app",
    "可以派的帮工：",
    "- 小林（id xiaolin，Claude Code）",
    "各频道里在场的帮工：",
    "  （没有帮工）",
    "你正在回话的地方：#general",
    "",
    "[来源：用户]",
    "用户说：帮我把登录超时修一下",
  ].join("\n");
  expect(collapsedStepSummary(userStep(userPrompt), userPrompt)).toBe("帮我把登录超时修一下");

  const chatPrompt = [
    "【现在】2026-11-26 21:05",
    "【现状变了】",
    "+ - 小林（在忙）",
    "",
    "[来源：群聊]（帮工写的是它的汇报）",
    "【群聊】#general 里有给你的话：",
    "[target=#general msg=12 from=小林] 所有单元测试都通过了",
    "  │ [附件 log.txt：/tmp/log.txt]",
    "",
    "你的回答会发在 #general。",
  ].join("\n");
  expect(collapsedStepSummary(userStep(chatPrompt), chatPrompt)).toBe("#general · 小林: 所有单元测试都通过了");

  const cronPrompt = [
    "【现在】2026-11-26 09:00",
    "【现状】",
    "仓库（工作目录 /var/folders/xx/work 下的文件夹）：app",
    "",
    "[来源：定时]",
    "每天九点跑一遍回归测试",
  ].join("\n");
  expect(collapsedStepSummary(userStep(cronPrompt), cronPrompt)).toBe("定时 · 每天九点跑一遍回归测试");

  const scaffoldingOnly = "【现在】2026-11-26 09:00\n【现状】\n用户的语言：zh\n仓库（工作目录 /var/folders/xx 下的文件夹）：（还没有）";
  expect(collapsedStepSummary(userStep(scaffoldingOnly), scaffoldingOnly)).toBe("状态上下文更新");

  const plain = "Fix login timeout";
  expect(collapsedStepSummary(userStep(plain), plain)).toBe("Fix login timeout");

  const apiKeyReport = [
    "【现在】2026-11-26 21:06",
    "[来源：群聊]（帮工写的是它的汇报）",
    "【群聊】#general:1 里有给你的话：",
    "[target=#general:1 msg=4 from=w1 Ada #4] no API key is set for the model",
  ].join("\n");
  expect(collapsedStepSummary(userStep(apiKeyReport), apiKeyReport)).toBe(`#general:1 · w1 Ada #4: ${t("web.issue.error.missingApiKey")}`);
});
