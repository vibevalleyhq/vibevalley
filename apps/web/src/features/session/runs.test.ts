import { expect, test } from "vite-plus/test";

import type { EventTokens, SessionEvent, SessionEventType } from "@vibevalley/protocol";

import { cacheHit, mergeSteps, runLabel, runsOf, runTitle, secondsText, shownEvents, summaryOf, tokensText, waterfallOf } from "./runs";

const e = (
  seq: number,
  time: number,
  type: SessionEventType,
  more: { text?: string; run?: string; call?: number; under?: number; tool?: string; input?: string; output?: string; ok?: boolean; tokens?: EventTokens } = {},
): SessionEvent => ({ seq, revision: 0, time, type, text: more.text ?? "", ...more, ...(type === "tool/call" ? { action: "run_command" } : {}) });

/** Two runs: the first thinks, runs a test and answers; the second answers straight away. */
const log = [
  e(0, 0, "run/start", { run: "r1" }),
  e(1, 0, "user/message", { run: "r1", text: "帮我跑测试" }),
  e(2, 1000, "assistant/thinking", { run: "r1", text: "想" }),
  e(3, 2000, "tool/call", { run: "r1", text: "pnpm test", tool: "Bash", input: '{"command": "pnpm test"}' }),
  e(4, 3000, "llm/usage", { run: "r1", tokens: { input: 100, cacheRead: 300, output: 50 } }),
  e(5, 7000, "tool/result", { run: "r1", call: 3, output: "12 passed", ok: true }),
  e(6, 8000, "assistant/message", { run: "r1", text: "测试都过了。" }),
  e(7, 9000, "llm/usage", { run: "r1", tokens: { input: 100, cacheRead: 500, output: 30 } }),
  e(8, 9000, "run/end", { run: "r1", text: "completed" }),
  e(9, 3600000, "run/start", { run: "r2" }),
  e(10, 3600000, "user/message", { run: "r2", text: "再看看 lint" }),
  e(11, 3602000, "assistant/message", { run: "r2", text: "lint 也干净。" }),
  e(12, 3603000, "llm/usage", { run: "r2", tokens: { input: 0, cacheRead: 0, output: 20 } }),
];

test("a step keeps its newest revision whichever of the snapshot or live copy arrives last", () => {
  const older = { ...e(1, 0, "assistant/message", { text: "测试" }), revision: 0 };
  const newer = { ...older, revision: 1, text: "测试通过" };
  expect(mergeSteps([newer], [older])).toEqual([newer]);
  expect(mergeSteps([older], [newer])).toEqual([newer]);
});

const of = (lane: string, fall = waterfallOf(log, 3603000)) => fall.spans.filter((s) => s.lane === lane).map((s) => [s.start, s.end, s.seq]);

test("the waterfall takes its lanes from the times the log has", () => {
  expect(waterfallOf(log, 3603000).runs).toEqual([
    [0, 9000],
    [3600000, 3603000],
  ]);
  // From what it answered to its usage: the message, then the tool's result, then the second message.
  expect(of("model")).toEqual([
    [0, 3000, 2],
    [7000, 9000, 6],
    [3600000, 3603000, 11],
  ]);
  expect(of("tool")).toEqual([[2000, 7000, 3]]);
  expect(of("asked").map((s) => s[2])).toEqual([1, 10]);
});

test("a call that has not returned runs to the end; with no usage the answer stops at its last step", () => {
  const fall = waterfallOf([e(1, 0, "user/message", { run: "r", text: "x" }), e(2, 500, "tool/call", { run: "r", text: "sleep 9" })], 4000);
  expect(fall.spans.map((s) => [s.lane, s.start, s.end])).toEqual([
    ["asked", 0, 500],
    ["model", 0, 4000],
    ["tool", 500, 4000],
  ]);
});

test("the summary counts runs, steps, the lanes' time and the usage's tokens", () => {
  const s = summaryOf(log, 3603000);
  expect([s.runs, s.steps]).toEqual([2, 6]);
  expect([s.modelMs, s.toolMs]).toEqual([8000, 5000]);
  expect([s.input, s.cacheRead, s.output]).toEqual([200, 800, 100]);
  expect(cacheHit(s)).toBe(0.8);
  expect(tokensText(32600)).toBe("3.3 万");
  expect(secondsText(1240)).toBe("1.2 秒");
  expect(secondsText(65000)).toBe("1 分 5 秒");
});

test("an orchestrator's run folds to how long it thought and what it used; one without tools says nothing", () => {
  const run = log.slice(0, 9);
  expect(runLabel(run, true)).toBe("想了 9 秒 · 用了 1 个工具");
  expect(runLabel(run, false)).toBe("用了 1 个工具");
  expect(runLabel(log.slice(9), true)).toBeUndefined();
});

test("one run that heard two messages is one view; the second message is among its steps", () => {
  const told = [
    e(0, 0, "run/start", { run: "r1" }),
    e(1, 0, "user/message", { run: "r1", text: "改提示" }),
    e(2, 1000, "assistant/message", { run: "r1", text: "在改" }),
    e(3, 2000, "user/message", { run: "r1", text: "顺便改按钮" }),
    e(4, 3000, "assistant/message", { run: "r1", text: "都改了" }),
    e(5, 3000, "run/end", { run: "r1", text: "completed" }),
  ];
  const views = runsOf(shownEvents(told));
  expect(views.map((v) => [v.run, v.asked?.seq, v.steps.map((s) => s.seq)])).toEqual([["r1", 1, [2, 3, 4]]]);
  expect(waterfallOf(told, 3000).runs).toEqual([[0, 3000]]);
  expect(summaryOf(told, 3000).runs).toBe(1);
});

test("steps outside every run are their own view, told apart from a run that heard nothing", () => {
  const views = runsOf([
    e(1, 0, "assistant/message", { text: "前面丢了" }),
    e(2, 10, "user/message", { run: "r1", text: "做吧" }),
    e(3, 20, "assistant/thinking", { run: "r2", text: "自己接着" }),
  ]);
  expect(views.map((v) => [v.run, v.asked?.seq, v.steps.length])).toEqual([
    [undefined, undefined, 1],
    ["r1", 2, 0],
    ["r2", undefined, 1],
  ]);
  expect(views.map((v) => runTitle(v, 2))).toEqual(["更早的几步", "工单", "自己起的一轮"]);
});
