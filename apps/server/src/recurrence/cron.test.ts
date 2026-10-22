// The recurrence and cron tests: the golden files have no cron, and these pin the clock changes. A recurrence is made Monday 2026-10-12 08:00 in Shanghai.

process.env.TZ = "Asia/Shanghai";

import { expect, test } from "vite-plus/test";
import type { Recurrence, RecurrenceRequest, RecurrenceWhen } from "@vibevalley/protocol";
import { emptyWorkspaceState } from "../core/core.ts";
import { nextRun, nextText, whenText } from "./when.ts";
import { reduce } from "../projection/reduce.ts";
import { frameOf } from "../projection/frame.ts";
import { recurrenceProblem } from "./rules.ts";

const sh = "Asia/Shanghai";
const at = (iso: string) => Date.parse(iso + "+08:00");

const make = (change: Partial<Recurrence> = {}): Recurrence => ({
  id: "c1",
  name: "测试",
  text: "跑一遍测试",
  channel: "c1",
  when: { kind: "daily", time: "09:00" },
  tz: sh,
  enabled: true,
  created: at("2026-10-12T08:00:00"),
  by: "owner",
  ...change,
});

const cron = (expr: string, change: Partial<Recurrence> = {}) => make({ when: { kind: "cron", expr }, ...change });

test("daily and weekly", () => {
  expect(nextRun(make())).toBe(at("2026-10-12T09:00:00"));
  expect(nextRun(make({ lastRun: at("2026-10-12T09:00:00") }))).toBe(at("2026-10-13T09:00:00"));
  expect(nextRun(make({ tz: "UTC" }))).toBe(Date.UTC(2026, 9, 12, 9));
  expect(nextRun(make({ when: { kind: "weekly", days: [5, 3], time: "18:30" } }))).toBe(at("2026-10-14T18:30:00"));
  expect(nextRun(make({ when: { kind: "weekly", days: [0], time: "07:00" } }))).toBe(at("2026-10-18T07:00:00"));
});

test("every and once", () => {
  const every: RecurrenceWhen = { kind: "every", minutes: 30 };
  expect(nextRun(make({ when: every }))).toBe(at("2026-10-12T08:30:00"));
  expect(nextRun(make({ when: every, lastRun: at("2026-10-12T10:00:00") }))).toBe(at("2026-10-12T10:30:00"));
  const once = make({ when: { kind: "once", at: at("2026-10-12T12:00:00") } });
  expect(nextRun(once)).toBe(at("2026-10-12T12:00:00"));
  const done = { ...once, lastRun: at("2026-10-12T12:00:05"), enabled: false };
  expect(nextRun(done)).toBeUndefined();
  expect(nextText(done)).toBe("做过了");
  expect(nextRun(make({ enabled: false }))).toBeUndefined();
});

test("what a recurrence asked for gets wrong", () => {
  const now = at("2026-10-12T08:00:00");
  const req = (change: Partial<RecurrenceRequest> = {}): RecurrenceRequest => ({
    name: "测试",
    text: "跑测试",
    when: { kind: "daily", time: "09:00" },
    ...change,
  });
  expect(recurrenceProblem(req(), now)).toBe("");
  expect(recurrenceProblem(req({ when: { kind: "daily", time: "9点" } }), now)).toMatch(/HH:MM/);
  expect(recurrenceProblem(req({ when: { kind: "once", at: now - 1 } }), now)).toMatch(/以后/);
  expect(recurrenceProblem(req({ when: { kind: "every", minutes: 0.2 } }), now)).toMatch(/至少/);
  expect(recurrenceProblem(req({ when: { kind: "weekly", days: [7], time: "09:00" } }), now)).toMatch(/0 到 6/);
  expect(recurrenceProblem(req({ tz: "Mars/Base" }), now)).toMatch(/时区/);
  expect(recurrenceProblem(req({ text: " " }), now)).toMatch(/做什么/);
  expect(recurrenceProblem(req({ tz: "+08:00" }), now)).toBe("");
  expect(recurrenceProblem(req({ tz: "Local" }), now)).toMatch(/时区/);
});

test("when it runs, in words", () => {
  expect(whenText({ kind: "daily", time: "09:00" }, sh)).toBe("每天 09:00");
  expect(whenText({ kind: "weekly", days: [3, 1], time: "09:00" }, sh)).toBe("每周一、三 09:00");
  expect(whenText({ kind: "every", minutes: 120 }, sh)).toBe("每 2 小时");
  expect(whenText({ kind: "every", minutes: 45 }, sh)).toBe("每 45 分钟");
  expect(whenText({ kind: "once", at: at("2026-01-06T00:03:00") }, sh)).toBe("1/6 00:03 一次");
});

test("the fold keeps the facts; the words are the frame's", () => {
  const s = make();
  const [one] = reduce(emptyWorkspaceState(), { type: "recurrence", at: 1, recurrence: s });
  expect(one.recurrences).toEqual([s]);
  expect(frameOf(one).state.recurrences).toEqual([{ ...s, whenText: "每天 09:00", nextText: "10/12 09:00" }]);
  expect(reduce(one, { type: "recurrence", at: 2, recurrence: s })[1]).toBe(false);
  const [off] = reduce(one, { type: "recurrence", at: 3, recurrence: { ...s, enabled: false } });
  expect(frameOf(off).state.recurrences?.[0]?.nextText).toBe("关着");
  const [gone] = reduce(off, { type: "recurrenceGone", at: 4, id: "c1" });
  expect(gone.recurrences).toEqual([]);
  expect(reduce(emptyWorkspaceState(), { type: "recurrenceGone", at: 5, id: "c9" })[1]).toBe(false);
});

test("cron's next run", () => {
  for (const [expr, last, want] of [
    ["0 9 * * 1-5", "", "2026-10-12T09:00:00"],
    ["0 9 * * 1-5", "2026-10-16T09:00:00", "2026-10-19T09:00:00"],
    ["15 * * * *", "", "2026-10-12T08:15:00"],
    ["*/20 8 * * *", "", "2026-10-12T08:20:00"],
    ["0 10 1 * *", "", "2026-11-01T10:00:00"],
    ["0 9 * * 7", "", "2026-10-18T09:00:00"],
    // Both day fields given: either one is due (the 13th is a Tuesday).
    ["0 9 13 * 5", "", "2026-10-13T09:00:00"],
    ["0 9 13 * 5", "2026-10-13T09:00:00", "2026-10-16T09:00:00"],
    ["0 0 29 2 *", "", "2028-02-29T00:00:00"],
    ["0,30 9-10 * * *", "2026-10-12T09:30:00", "2026-10-12T10:00:00"],
  ] as const) {
    expect([expr, last, nextRun(cron(expr, last ? { lastRun: at(last) } : {}))]).toEqual([expr, last, at(want)]);
  }
});

test("a cron the old kinds can say runs when they do, across clock changes too", () => {
  // New York: 2026-03-08 springs forward at 02:00, 2026-11-01 falls back at 02:00.
  const froms = [
    Date.parse("2026-03-07T12:00:00-05:00"),
    Date.parse("2026-03-08T01:59:00-05:00"),
    Date.parse("2026-10-31T23:00:00-04:00"),
    Date.parse("2026-11-01T01:30:00-04:00"),
  ];
  for (const tz of ["America/New_York", sh]) {
    for (const time of ["02:30", "01:30", "00:00", "23:59"]) {
      for (const created of froms) {
        const expr = time.slice(3) + " " + time.slice(0, 2);
        const daily = nextRun(make({ tz, created, when: { kind: "daily", time } }));
        const weekly = nextRun(make({ tz, created, when: { kind: "weekly", days: [0, 3], time } }));
        expect(daily).toBeDefined();
        expect([tz, time, created, nextRun(cron(expr + " * * *", { tz, created }))]).toEqual([tz, time, created, daily]);
        expect([tz, time, created, nextRun(cron(expr + " * * 0,3", { tz, created }))]).toEqual([tz, time, created, weekly]);
      }
    }
  }
});

test("what a cron gets wrong", () => {
  const now = at("2026-10-12T08:00:00");
  const problem = (expr: string) => recurrenceProblem({ name: "n", text: "t", when: { kind: "cron", expr }, tz: sh }, now);
  for (const [expr, pattern] of [
    ["0 9 * * 1-5", /^$/],
    ["*/5 * * * *", /^$/],
    ["0 9 * *", /五段/],
    ["60 * * * *", /分钟/],
    ["0 24 * * *", /小时/],
    ["0 9 0 * *", /日/],
    ["0 9 * 13 *", /月/],
    ["0 9 * * 8", /周几/],
    ["0 9 5-1 * *", /日/],
    ["*/0 * * * *", /分钟/],
    ["a b c d e", /分钟/],
    ["0 0 30 2 *", /永远/],
  ] as const) {
    expect(problem(expr)).toMatch(pattern);
  }
});

test("cron in words", () => {
  for (const [expr, want] of Object.entries({
    "0 9 * * *": "每天 09:00",
    "0 9 * * 1-5": "工作日 09:00",
    "0 10 * * 6,0": "周末 10:00",
    "30 18 * * 3,1": "每周一、三 18:30",
    "0 7 * * 7": "每周日 07:00",
    "0 10 1 * *": "每月 1 号 10:00",
    "15 * * * *": "每小时第 15 分",
    "*/5 * * * *": "cron */5 * * * *",
    "0 9 1 1 *": "cron 0 9 1 1 *",
    bad: "cron bad",
  })) {
    expect(whenText({ kind: "cron", expr }, sh)).toBe(want);
  }
});
