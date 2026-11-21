// The issues pages' part of the workbench fixture (merged by workbench.ts):
// answers by op, as vibevalley_bridge::fake reads responses.json. The reads an
// open issue makes (changes, story, runs, steps) answer with VibeValley's
// own story data (IssueDetail.stories.tsx, session.samples.ts).
// `withIssues` adds the issue pages' own cases (VibeValley's issue page
// stories: one working, one to review, one asking, a family) to a fixture,
// for the issue tests and pictures; the workbench keeps its seven cards.
import type { Issue, IssueHistory, Milestone, Run, SessionEvent, SessionView, StateFrame } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { acts, min, now, sampleChanges, sampleIssue, sampleSession, type SampleIssue, working } from "../features/issue/model/issue.samples";
import { finishedRun, liveRun } from "../features/session/session.samples";

const description = "过期的会话现在报错，页面一直转圈。\n\n要做的：过期就回到登录页，说清楚为什么。";
const criteria = ["过期的会话回到登录页", "登录页说「登录过期了」", "补一条跨过期限的测试"];

const milestones: Milestone[] = [
  { at: now - 6 * min, kind: "reported", who: "老周", text: "过期回到登录页，登录页说明原因，加了两条测试。" },
  { at: now - 9 * min, kind: "told", text: "再补一条跨过期限的测试。" },
  { at: now - 20 * min, kind: "started", who: "老周", text: "开始做了" },
  { at: now - 40 * min, kind: "opened", text: "写下这张工单" },
];

const runs: Run[] = [
  {
    id: "run-1",
    session: "w4" as Run["session"],
    subagents: {
      run: "run-1",
      rootThreadId: "main",
      waits: [],
      threads: [{ threadId: "old-review", parentThreadId: "main", task: "复查登录提示", status: "completed", updatedAt: now - 20 * min }],
    },
    triggeredBy: { kind: "issue" },
    heard: [],
    startedAt: now - 20 * min,
    endedAt: now - 14 * min,
    outcome: "completed",
    summary: "过期回到登录页，加了两条测试。",
  },
  {
    id: "run-2",
    session: "w4" as Run["session"],
    triggeredBy: { kind: "comment", message: "再补一条跨过期限的测试。" },
    heard: ["再补一条跨过期限的测试。"],
    startedAt: now - 9 * min,
    endedAt: now - 6 * min,
    outcome: "completed",
    summary: "补了跨过期限的测试。",
  },
];

/** `{ op: data }` as vibevalley_bridge::fake reads responses.json. */
export const responses: Record<string, unknown> = {
  // The sample's first hunk header counts 7 and 11 lines for 2 and 7: corrected, so the review draws it with DiffView.
  "issue.diff.get": {
    ...sampleChanges,
    files: sampleChanges.files.map((f) => (f.patch ? { ...f, patch: f.patch.replace("@@ -10,7 +10,11 @@", "@@ -10,2 +10,7 @@") } : f)),
  },
  "issue.timeline.get": { milestones, spent: { tokens: 182_400, cny: 0.42 } },
  "issue.run.list": runs,
  "issue.conversation.get": null,
  "session.event.list": [...finishedRun, ...liveRun],
};

const base = (number: number, title: string, more: SampleIssue) =>
  sampleIssue(number, title, "in_review", "high", omitUndefined({ description, criteria, repo: "vibevalley", agent: "laozhou", ...more }));

const lastRun = (outcome: "completed" | "failed" | "interrupted", summary: string) => ({ outcome, summary, at: now - 6 * min });

const at = { repo: "vibevalley", branch: "issue-31-login", worktree: "/Users/me/vibevalley/.worktrees/issue-31-login" };
const workingSession = sampleSession("w5", "laozhou", working(now - 4 * min), {
  name: "老周",
  ...at,
  branch: "issue-32-settings",
  runtime: "codex",
  subagents: {
    run: "run-2",
    rootThreadId: "main",
    waits: [{ threadId: "main", callId: "wait-1", targets: ["test-settings"] }],
    threads: [
      {
        threadId: "test-settings",
        parentThreadId: "main",
        task: "测试设置分组",
        status: "running",
        lastActivity: "运行设置页测试",
        steps: [
          { step: "运行设置页键盘用例", status: "inProgress" },
          { step: "复核测试输出", status: "pending" },
        ],
        updatedAt: now - 2 * min,
      },
      { threadId: "review-groups", parentThreadId: "main", task: "核对分组名称", status: "completed", updatedAt: now - 3 * min },
    ],
  },
});
const reviewSession = sampleSession(
  "w4",
  "laozhou",
  { _tag: "resting" },
  { name: "老周", ...at, runs: 3, lastRun: lastRun("completed", "过期回到登录页，登录页说明原因，加了两条测试。") },
);
const askingSession = sampleSession(
  "w6",
  "xiaolin",
  { _tag: "resting" },
  { name: "小林", repo: "vibevalley", runs: 1, lastRun: lastRun("completed", "两种做法，要你挑一个。") },
);

const sessions: SessionView[] = [workingSession, reviewSession, askingSession];

// The helpers a profile sent (the trajectories view), by op only: every profile has these.
responses["session.list"] = [
  { ...workingSession, brief: "设置页按用途分组" },
  { ...reviewSession, brief: "修好登录过期", phase: { _tag: "closed", at: now - 5 * min, closed: "merged" } },
];

const issues: Issue[] = [
  base(32, "设置页按用途分组", {
    status: "in_progress",
    description: "设置太散了，找一个开关要翻很久。\n\n按用途分成几组：帮工、模型、外观、连接。",
    criteria: ["设置按四组排", "每组一个标题", "原来的开关一个不少"],
    sessionIds: [workingSession.id],
    stage: { state: "working", since: now - 4 * min, acts: [acts.tell, acts.stop, acts.close] },
  }),
  base(31, "修好登录过期", {
    sessionIds: [reviewSession.id],
    checks: [
      { criterion: 0, result: "met", proof: "session.test.ts 覆盖了" },
      { criterion: 1, result: "met", proof: "" },
      { criterion: 2, result: "unsure", proof: "只测了过期前后各一秒" },
    ],
    stage: { state: "reviewing", since: now - 6 * min, lead: "complete", acts: [acts.complete, acts.reject, acts.tell, acts.close] },
  }),
  base(33, "过期以后怎么登录", {
    agent: "xiaolin",
    sessionIds: [askingSession.id],
    questions: [{ question: "过期以后回登录页，还是原地弹一个登录框？", options: ["回登录页", "原地弹框"] }],
    stage: { state: "asking", since: now - 6 * min, lead: "answer", acts: [acts.answer, acts.close] },
  }),
  sampleIssue(40, "登录整体重做", "in_progress", "high", {
    description: "登录这一块分三步重做：过期、记住我、退出。",
    repo: "vibevalley",
    stage: { state: "working", since: now - 30 * min, acts: [acts.close] },
  }),
  sampleIssue(41, "记住我", "todo", "medium", { parent: "i40" as Issue["parent"], repo: "vibevalley", agent: "xiaolin" }),
  sampleIssue(42, "退出以后清干净", "backlog", "low", { parent: "i40" as Issue["parent"], repo: "vibevalley" }),
];

const history = (all: readonly Issue[], known: readonly SessionView[]): IssueHistory[] =>
  all.map((i) => ({
    issue: i,
    sessions: known.filter((s) => i.assignments.some((a) => a.executions.some((e) => e.session === s.id))),
    missingSessions: [],
  }));

/** A fixture with the issue pages' own cases added. */
export function withIssues(fixture: { state: StateFrame; responses: Record<string, unknown> }): { state: StateFrame; responses: Record<string, unknown> } {
  const space = fixture.state.state as unknown as { issues: Issue[]; sessions: SessionView[] };
  const allIssues = [...space.issues, ...issues];
  const allSessions = [...space.sessions, ...sessions];
  return {
    state: { ...fixture.state, state: { ...fixture.state.state, issues: allIssues, sessions: allSessions } },
    responses: {
      ...fixture.responses,
      ...responses,
      "session.event.list": ({ id }: { id: string }) =>
        id === "w5"
          ? ([
              ...finishedRun,
              ...liveRun,
              { seq: 310, revision: 0, run: "run-2", time: now - 2 * min, threadId: "test-settings", type: "assistant/message", text: "设置项分组用例通过" },
              { seq: 311, revision: 0, run: "run-2", time: now - 3 * min, threadId: "review-groups", type: "assistant/message", text: "四组名称核对完毕" },
              { seq: 312, revision: 0, run: "run-1", time: now - 12 * min, threadId: "test-settings", type: "assistant/message", text: "旧轮用例通过" },
            ] satisfies SessionEvent[])
          : [...finishedRun, ...liveRun],
      "issue.history.list": history(allIssues, allSessions),
    },
  };
}
