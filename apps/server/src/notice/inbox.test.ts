// The inbox's kinds the golden files have no case of.

import { expect, test } from "vite-plus/test";
import type { WorkspaceState, Issue, Session } from "@vibevalley/protocol";
import { freshOf } from "@vibevalley/protocol/rules";
import { emptyWorkspaceState } from "../core/core.ts";
import { inbox } from "./inbox.ts";

test("a helper handed back with questions asks the owner to answer, not to complete it", () => {
  const session = {
    id: "w1",
    name: "阿狐",
    agent: "lab",
    runtime: "pi",
    brief: "写打卡",
    hiredAt: 1000,
    runs: 1,
    issue: "t1",
    phase: { _tag: "done" },
    lastRun: { outcome: "completed", summary: "做完了", at: 2000 },
  } as unknown as Session;
  const issue = {
    id: "t1",
    number: 41,
    title: "写打卡",
    sessions: ["w1"],
    questions: [{ question: "用 8787 还是 8797？" }],
  } as unknown as Issue;
  // As the server writes it: the questions make the attention.
  const state = (questions: Issue["questions"]): WorkspaceState => ({
    ...emptyWorkspaceState(),
    sessions: [session],
    issues: [
      {
        ...issue,
        questions,
        attention: { state: questions.length > 0 ? "asking" : "reviewing", acts: [] },
      },
    ],
  });
  expect(inbox(state(issue.questions)).map((i) => [i.kind, i.text])).toEqual([["ask", "用 8787 还是 8797？"]]);
  expect(inbox(state([])).map((i) => i.kind)).toEqual(["review"]);
});

test("the inbox says what the issue's attention says: a round stopped halfway wants the owner too", () => {
  const session = {
    id: "w1",
    name: "阿狐",
    agent: "lab",
    runtime: "pi",
    brief: "写打卡",
    hiredAt: 1,
    runs: 1,
    issue: "t1",
    phase: { _tag: "done" },
    lastRun: { outcome: "interrupted", summary: "停下了", at: 2 },
  } as unknown as Session;
  const issue = {
    id: "t1",
    number: 41,
    title: "写打卡",
    sessions: ["w1"],
    questions: [],
    attention: { state: "stuck", stuck: "interrupted", since: 2, acts: [] },
  } as unknown as Issue;
  expect(inbox({ ...emptyWorkspaceState(), sessions: [session], issues: [issue] }).map((i) => i.kind)).toEqual(["interrupted"]);
  // Closed by the owner, the helper still on the farm asks nothing.
  expect(
    inbox({
      ...emptyWorkspaceState(),
      sessions: [session],
      issues: [{ ...issue, attention: { state: "canceled", acts: [] } }],
    }),
  ).toEqual([]);
});

test("each item is worded for every route: the phone, the system notice, the tray", () => {
  const session = {
    id: "w1",
    name: "小吴",
    agent: "lab",
    runtime: "pi",
    brief: "写打卡",
    hiredAt: 1,
    runs: 1,
    issue: "t1",
    phase: { _tag: "done" },
    lastRun: { outcome: "completed", summary: "打卡\n  写好了", at: 2 },
  } as unknown as Session;
  const issue = {
    id: "t1",
    number: 41,
    title: "写打卡",
    sessions: ["w1"],
    questions: [],
    attention: { state: "reviewing", acts: [] },
  } as unknown as Issue;
  const recurrence = {
    id: "s1",
    name: "每天看测试",
    channel: "c1",
    created: 3,
    pending: true,
  } as unknown as NonNullable<WorkspaceState["recurrences"]>[number];
  const [handedBack, asked] = [
    ...inbox({
      ...emptyWorkspaceState(),
      sessions: [session],
      issues: [issue],
      recurrences: [recurrence],
    }),
  ].sort((a, b) => a.at - b.at);
  expect([handedBack!.who, handedBack!.words]).toEqual(["小吴", { label: "等你看", title: "小吴 做完了", body: "打卡 写好了", tray: "小吴 做完了，等你看" }]);
  expect([asked!.who, asked!.words]).toEqual([
    "管家",
    {
      label: "定时等你同意",
      title: "管家想定一个定时",
      body: "「每天看测试」：同意了才开始",
      tray: "定时「每天看测试」等你同意",
    },
  ]);
});

test("news: the first look knows what stands; after it each new id is news once", () => {
  const item = (id: string) => ({ id }) as unknown as ReturnType<typeof inbox>[number];
  let { fresh, known } = freshOf(undefined, [item("a")]);
  expect(fresh).toEqual([]);
  ({ fresh, known } = freshOf(known, [item("a"), item("b")]));
  expect(fresh.map((i) => i.id)).toEqual(["b"]);
  ({ fresh, known } = freshOf(known, [item("a"), item("b")]));
  expect(fresh).toEqual([]);
});
