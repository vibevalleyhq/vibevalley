import type { Milestone, Run } from "@vibevalley/protocol";

import { min, now, sampleChanges, sampleSession, working } from "../features/issue/model/issue.samples";
import { finishedRun, liveRun } from "../features/session/session.samples";

const milestones: Milestone[] = [
  { at: now - 40 * min, kind: "opened", text: "写下这张工单" },
  { at: now - 20 * min, kind: "started", who: "老周", text: "开始做了", run: "run-1" },
  { at: now - 14 * min, kind: "reported", who: "老周", text: "交回来了", said: "过期回到登录页，加了两条测试。", run: "run-1" },
  { at: now - 9 * min, kind: "started", who: "老周", text: "你带了话，接着做一轮", run: "run-2" },
  { at: now - 6 * min, kind: "reported", who: "老周", text: "交回来了", said: "过期回到登录页，登录页说明原因，加了两条测试。", run: "run-2" },
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

const sessionEvents = [...finishedRun, ...liveRun];
const oldestSeq = sessionEvents[0]?.seq;
const newestSeq = sessionEvents.at(-1)?.seq;

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
  "session.event.list": {
    events: sessionEvents,
    hasMore: false,
    ...(oldestSeq !== undefined ? { oldestSeq } : {}),
    ...(newestSeq !== undefined ? { newestSeq } : {}),
  },
};

const lastRun = (outcome: "completed" | "failed" | "interrupted", summary: string) => ({ outcome, summary, at: now - 6 * min });

const repoDir = "/Users/me/vibevalley";
const workingSession = sampleSession("w5", "laozhou", working(now - 4 * min), {
  name: "老周",
  cwd: repoDir,
  policy: { kind: "directCwd", repo: "vibevalley", permissionMode: "bypass" },
  bindings: [],
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
  {
    name: "老周",
    cwd: repoDir,
    policy: { kind: "directCwd", repo: "vibevalley", permissionMode: "bypass" },
    bindings: [],
    runs: 3,
    lastRun: lastRun("completed", "过期回到登录页，登录页说明原因，加了两条测试。"),
  },
);

// The helpers a profile sent (the trajectories view), by op only: every profile has these.
responses["session.list"] = [
  { ...workingSession, brief: "设置页按用途分组" },
  { ...reviewSession, brief: "修好登录过期", phase: { _tag: "closed", at: now - 5 * min, closed: "merged" } },
];
