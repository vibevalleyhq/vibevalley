// Writes golden JSON for vibevalley-protocol from VibeValley's own code, imported
// from the copy gen/prepare.sh makes (gen/run.sh runs this).
// Every value goes through VibeValley's zod schema for its type before it is
// written, and states come from its real `reduce` and `frameOf`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const VV = process.argv[2]!;
const out = process.argv[3]!;

// The web samples stamp Date.now(): pin it so the goldens are the same on every run.
Date.now = () => 1_794_500_000_000;

const S = await import(`${VV}/packages/protocol/src/schema.ts`);
const E = await import(`${VV}/packages/protocol/src/endpoint.ts`);
const { sampleIssue } = await import(`${VV}/apps/web/src/features/issue/model/issue.samples.ts`);
const sessions = await import(`${VV}/apps/web/src/features/session/session.samples.ts`);
const { reduce } = await import(`${VV}/apps/server/src/gateway/projection/reduce.ts`);
const { frameOf } = await import(`${VV}/apps/server/src/gateway/projection/frame.ts`);
const { emptySpaceState } = await import(`${VV}/apps/server/src/core/core.ts`);

const T0 = 1_794_500_000_000;
const min = 60_000;

const write = (name: string, schema: { parse: (v: unknown) => unknown } | undefined, values: unknown[]) => {
  const checked = schema ? values.map((v) => schema.parse(v)) : values;
  writeFileSync(join(out, `${name}.json`), JSON.stringify(checked, null, 1) + "\n");
  console.log(`${name}: ${checked.length}`);
};

// ---- facts folded by the server's reduce, framed by its frameOf ----

const worker = (id: string, issue: string, phase: unknown, more: Record<string, unknown> = {}) => ({
  id,
  role: "worker",
  name: `Helper ${id}`,
  agent: "lab",
  runtime: "claude",
  brief: `work on ${issue}`,
  repo: "demo",
  branch: `vibevalley/issue-${id.slice(1)}`,
  worktree: `/tmp/worktrees/demo.${id.slice(1)}`,
  hiredAt: T0,
  runs: 0,
  phase,
  refining: false,
  issue,
  ...more,
});

const working = (since: number, more: Record<string, unknown> = {}) => ({
  _tag: "working",
  since,
  doing: { action: "run_command", label: "vp test" },
  ...more,
});

const issueWith = (n: number, status: string, sessionIds: string[], more: Record<string, unknown> = {}) => {
  const base = sampleIssue(n, `Issue ${n}`, status, n % 2 ? "high" : "medium", { agent: "lab", sessionIds, ...more });
  return { ...base, createdAt: T0 - n * 37 * min, assignments: base.assignments.map((a: any) => ({ ...a, assignedAt: T0 - n * min, executions: a.executions.map((e: any) => ({ ...e, startedAt: T0 })) })) };
};

const facts: any[] = [
  { type: "sessionChanged", at: T0, session: worker("w1", "i1", working(T0)) },
  { type: "sessionChanged", at: T0, session: worker("w2", "i2", { _tag: "resting" }) },
  { type: "sessionChanged", at: T0, session: worker("w3", "i3", { _tag: "resting" }) },
  { type: "sessionChanged", at: T0, session: worker("w4", "i4", { _tag: "resting" }) },
  { type: "sessionChanged", at: T0, session: worker("w5", "i5", working(T0, { quietSince: T0 + 5 * min, retry: { attempt: 1, of: 3 } })) },
  { type: "sessionChanged", at: T0, session: worker("w6", "i6", { _tag: "resting" }) },
  { type: "issueChanged", at: T0, issue: issueWith(1, "todo", ["w1"], { description: "Fix the login", criteria: ["logs in"] }) },
  { type: "issueChanged", at: T0, issue: issueWith(2, "todo", ["w2"], { questions: [{ question: "Which port?", options: ["8080", "9090"] }] }) },
  { type: "issueChanged", at: T0, issue: issueWith(3, "todo", ["w3"], { conflict: { base: "main", files: ["a.ts"] } }) },
  { type: "issueChanged", at: T0, issue: issueWith(4, "todo", ["w4"], { deliver: "answer" }) },
  { type: "issueChanged", at: T0, issue: issueWith(5, "todo", ["w5"], { repo: "demo", blockedBy: [] }) },
  { type: "issueChanged", at: T0, issue: issueWith(6, "todo", ["w6"], { constraints: { check: "sh check.sh", scope: ["check.sh"], acceptance: true, frozen: [] } }) },
  { type: "issueChanged", at: T0, issue: issueWith(7, "backlog", [], { rank: 1024 }) },
  { type: "issueChanged", at: T0, issue: issueWith(8, "todo", [], { queuedAt: T0 }) },
  { type: "issueChanged", at: T0, issue: issueWith(9, "done", [], { closedAt: T0, delivered: "merged" }) },
  { type: "issueChanged", at: T0, issue: issueWith(10, "canceled", [], { closedAt: T0, canceled: "dismissed" }) },
  { type: "issueChanged", at: T0, issue: issueWith(11, "todo", [], { lastRun: { startedAt: T0, endedAt: T0 + min, outcome: "completed" } }) },
  {
    type: "sessionReported",
    at: T0 + 2 * min,
    id: "w2",
    outcome: "completed",
    summary: "Asked about the port",
    runs: 1,
    questions: [{ question: "Which port?", options: ["8080", "9090"] }],
    checks: [],
  },
  { type: "sessionReported", at: T0 + 3 * min, id: "w3", outcome: "completed", summary: "Done; conflicts", runs: 1, questions: [], checks: [] },
  {
    type: "sessionReported",
    at: T0 + 4 * min,
    id: "w4",
    outcome: "completed",
    summary: "Found it",
    runs: 2,
    spent: { tokens: 1200, cny: 0.37 },
    questions: [],
    checks: [{ criterion: 0, result: "met", proof: "ran it" }],
    answer: { conclusion: "It is 42.", evidence: ["a.ts:1"], unsure: [], next: ["ship"] },
  },
  { type: "sessionReported", at: T0 + 5 * min, id: "w6", outcome: "failed", summary: "Build broke", runs: 1, questions: [], checks: [] },
];

let state = emptySpaceState();
const folded: unknown[] = [];
for (const fact of facts) {
  S.Fact.parse(fact);
  const [next, changed] = reduce(state, fact);
  if (changed) state = next;
  folded.push(fact);
}
const frame = frameOf(state, [], 7);
const parsedFrame = S.StateFrame.parse(frame);
write("facts", S.Fact, folded);
write("issues", S.Issue, parsedFrame.state.issues);
write("sessions", S.Session, state.sessions);
write("session_views", undefined, parsedFrame.state.sessions);
write("inbox", undefined, parsedFrame.inbox);
writeFileSync(join(out, "state_frame.json"), JSON.stringify(parsedFrame, null, 1) + "\n");

// ---- standalone values ----

write("session_events", S.SessionEvent, [
  ...sessions.finishedRun,
  ...sessions.failedRun,
  { seq: 1, revision: 2, time: T0, type: "run/error", text: "mcp failed", connection: { server: "fs", status: "failed", reason: "exit 1" } },
]);
write("phases", S.Phase, [
  working(T0),
  working(T0, { quietSince: T0 + min, retry: { attempt: 2 } }),
  { _tag: "done" },
  { _tag: "failed" },
  { _tag: "resting" },
  { _tag: "closed", at: T0, closed: "merged" },
]);
write("crons", S.Cron, [
  { id: "c1", name: "Daily digest", text: "summarize", channel: "default", when: { kind: "daily", time: "09:00" }, tz: "Asia/Shanghai", enabled: true, created: T0, by: "user", pending: false },
  { id: "c2", name: "Weekly", text: "w", channel: "default", agent: "lab", repo: "demo", when: { kind: "weekly", days: [1, 3], time: "18:30" }, tz: "+08:00", enabled: false, created: T0, lastRun: T0 + min, by: "agent", pending: true },
  { id: "c3", name: "Once", text: "o", channel: "c", when: { kind: "once", at: T0 }, tz: "UTC", enabled: true, created: T0, by: "system", pending: false },
  { id: "c4", name: "Every", text: "e", channel: "c", when: { kind: "every", minutes: 30 }, tz: "UTC", enabled: true, created: T0, by: "user", pending: false },
  { id: "c5", name: "Expr", text: "x", channel: "c", when: { kind: "cron", expr: "0 9 * * 1-5" }, tz: "UTC", enabled: true, created: T0, by: "user", pending: false },
]);
write("issue_requests", S.IssueRequest, [
  { title: "t" },
  { title: "child", parent: "i1", blockedBy: ["i2"], constraints: { scope: [], acceptance: false, frozen: [] }, description: "d", repo: "demo", agent: "lab", priority: "urgent", deliver: "pull_request", autoSubmitPr: true, criteria: ["c"], requestKey: "k" },
]);
write("status_requests", S.IssueStatusRequest, [
  { status: "todo" },
  { status: "done", text: "ok", agent: "lab", edit: { title: "t", before: "" }, requestKey: "k" },
]);
write("error_envelopes", E.ApiErrorEnvelope, [
  { bizCode: E.BizCode.IssueNotFound, message: "没有这张工单" },
  { bizCode: E.BizCode.VoiceUnavailable, message: "语音未配置", error: { settings: "models" } },
  { bizCode: E.BizCode.IssueRefused, message: "no", error: { next: [{ say: "start it", run: ["vibevalley issue start 1"] }, { say: "wait" }] } },
]);
write("biz_codes", undefined, [E.BizCode]);
write("biz_code_meta", undefined, [E.bizCodeMeta]);

// ---- projection scenarios: facts folded by the server's reduce, effects by effectsOf, framed by frameOf ----
// vibevalley-core's tests/projection.rs folds the same facts and must write the same JSON after every fact.

const { effectsOf } = await import(`${VV}/apps/server/src/modules/game/view.ts`);
const { mkdirSync } = await import("node:fs");
const projectionDir = join(out, "projection");
mkdirSync(projectionDir, { recursive: true });

const scenario = (name: string, steps: any[]) => {
  let st = emptySpaceState();
  let seq = 0;
  const effects: unknown[] = [];
  const folds = steps.map((fact) => {
    S.Fact.parse(fact);
    const before = st;
    const [next, changed] = reduce(st, fact);
    const made = changed ? effectsOf(before, fact) : [];
    if (changed) {
      st = next;
      seq++;
      effects.push(...made);
    }
    return { fact, changed, effects: made, state: S.SpaceState ? st : st };
  });
  const frame = S.StateFrame.parse(frameOf(st, effects, seq));
  writeFileSync(join(projectionDir, `${name}.json`), JSON.stringify({ folds, frame }, null, 1) + "\n");
  console.log(`projection/${name}: ${folds.length} facts`);
};

scenario("board", facts);

const ch = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "channel",
  default: false,
  category: "work",
  notify: "all",
  description: "",
  subjectKind: null,
  replies: 0,
  title: id,
  at: T0,
  ...more,
});
const msg = (id: string, channel: string, number: number, more: Record<string, unknown> = {}) => ({
  id,
  number,
  channel,
  from: "w1",
  actor: { kind: "agent", id: "w1", role: "worker", name: "Helper w1" },
  name: "Helper w1",
  kind: "chat",
  text: `message ${number} @user`,
  mentions: ["user"],
  outcome: null,
  spoken: false,
  at: T0 + number * min,
  revision: 1,
  reactions: [],
  attachments: [],
  embeds: [],
  ...more,
});
const doing = (since: number, action: string, label: string, more: Record<string, unknown> = {}) => ({
  _tag: "working",
  since,
  doing: { action, label },
  ...more,
});
const phase = (at: number, id: string, p: unknown, more: Record<string, unknown> = {}) => ({ type: "sessionPhaseChanged", at, id, phase: p, ...more });

scenario("sessions_and_farm", [
  { type: "sessionChanged", at: T0, session: worker("w1", "i1", { _tag: "resting" }) },
  { type: "sessionChanged", at: T0, session: worker("w2", "i2", { _tag: "resting" }, { repo: "other" }) },
  { type: "sessionChanged", at: T0, session: (({ issue: _i, repo: _r, branch: _b, worktree: _w, ...rest }) => ({ ...rest, role: "orchestrator" }))(worker("o1", "i0", { _tag: "resting" })) },
  { type: "sessionChanged", at: T0, session: worker("w3", "i3", { _tag: "resting" }) },
  phase(T0 + min, "w1", doing(T0 + min, "thinking", "")),
  phase(T0 + 2 * min, "w1", doing(T0 + min, "read_file", "src/a.ts")),
  phase(T0 + 3 * min, "w1", doing(T0 + min, "edit_file", "src/a.ts")),
  phase(T0 + 3 * min, "w1", doing(T0 + min, "edit_file", "src/a.ts")),
  phase(T0 + 4 * min, "w1", doing(T0 + min, "run_command", "vp test"), { spent: { tokens: 300 }, channel: "c1" }),
  phase(T0 + 5 * min, "w1", doing(T0 + min, "run_command", "vp test", { quietSince: T0 + 5 * min })),
  phase(T0 + 6 * min, "w3", doing(T0 + 6 * min, "web", "docs", { retry: { attempt: 2, of: 3 } }), { brief: "new brief" }),
  { type: "sessionToolChanged", at: T0 + 6 * min, id: "w3", connection: { server: "fs", status: "starting" } },
  { type: "sessionToolChanged", at: T0 + 6 * min, id: "w3", connection: { server: "fs", status: "ready" } },
  { type: "sessionToolChanged", at: T0 + 6 * min, id: "w3", connection: { server: "gh", status: "failed", reason: "no token" } },
  { type: "sessionToolsReset", at: T0 + 7 * min, id: "w3" },
  { type: "sessionToolChanged", at: T0 + 7 * min, id: "nobody", connection: { server: "fs", status: "ready" } },
  { type: "progressChanged", at: T0 + 7 * min, station: { id: "w3", station: 4 } },
  { type: "progressChanged", at: T0 + 7 * min, station: { id: "w2", station: 0 } },
  { type: "progressChanged", at: T0 + 7 * min, commits: { total: 5, repos: [{ path: "demo", commits: 5 }] } },
  { type: "progressChanged", at: T0 + 8 * min, commits: { total: 75, repos: [{ path: "demo", commits: 75 }] } },
  {
    type: "progressChanged",
    at: T0 + 8 * min,
    progress: { coins: 40, streak: 2, bestStreak: 3, counts: { s_hire: 1, harvest: 4 }, unlocked: [{ id: "s_hire", tier: 1, at: T0 }], agents: {} },
    news: { coins: 20, session: "w1", unlocked: [{ id: "s_hire", tier: 1, at: T0 }] },
  },
  { type: "sessionReported", at: T0 + 9 * min, id: "w2", outcome: "failed", summary: "broke", runs: 1, questions: [], checks: [] },
  { type: "sessionReported", at: T0 + 9 * min, id: "w3", outcome: "interrupted", summary: "stopped", runs: 2, questions: [], checks: [], spent: { tokens: 10, cny: 0.01 } },
  { type: "sessionReported", at: T0 + 9 * min, id: "nobody", outcome: "completed", summary: "x", runs: 1, questions: [], checks: [] },
  phase(T0 + 10 * min, "w3", { _tag: "done" }),
  { type: "sessionLeft", at: T0 + 11 * min, id: "w2", closed: "dismissed" },
  { type: "sessionChanged", at: T0 + 12 * min, session: worker("w4", "i4", { _tag: "resting" }) },
]);

scenario("chat_crons_and_rest", [
  { type: "channelChanged", at: T0, channel: ch("c1", { default: true, name: "general" }) },
  { type: "channelChanged", at: T0, channel: ch("c2", { name: "dev" }) },
  { type: "channelChanged", at: T0, channel: ch("c2", { name: "dev" }) },
  { type: "channelChanged", at: T0, channel: ch("t1", { type: "thread", parent: "c2", root: "m1", rootNumber: 1 }) },
  { type: "messageChanged", at: T0, message: msg("m1", "c2", 1) },
  { type: "messageChanged", at: T0, message: msg("m1", "c2", 1) },
  { type: "messageChanged", at: T0, message: msg("m9", "nowhere", 9) },
  {
    type: "userMentionsChanged",
    at: T0,
    mentions: [
      { message: msg("m1", "c2", 1), channel: "c2", address: "#dev" },
      { message: msg("m2", "c1", 2, { from: "orchestrator", actor: { kind: "agent", id: "orchestrator", role: "orchestrator" }, name: "管家" }), channel: "c1", address: "#general" },
    ],
  },
  { type: "channelRemoved", at: T0, id: "c2" },
  { type: "channelRemoved", at: T0, id: "c2" },
  { type: "cronChanged", at: T0, cron: { id: "k1", name: "Daily digest", text: "summarize", channel: "c1", when: { kind: "daily", time: "09:00" }, tz: "Asia/Shanghai", enabled: false, created: T0, by: "agent", pending: true } },
  { type: "cronChanged", at: T0, cron: { id: "k2", name: "Once", text: "o", channel: "c1", when: { kind: "once", at: T0 - min }, tz: "UTC", enabled: false, created: T0, by: "user", pending: false } },
  { type: "cronChanged", at: T0, cron: { id: "k2", name: "Once", text: "o", channel: "c1", when: { kind: "once", at: T0 - min }, tz: "UTC", enabled: false, created: T0, by: "user", pending: false } },
  { type: "cronRemoved", at: T0, id: "k2" },
  { type: "cronRemoved", at: T0, id: "k2" },
  { type: "connectorChanged", at: T0, status: { id: "weixin", state: "off", qr: "", pairCode: "", pending: 0, error: "" } },
  { type: "connectorChanged", at: T0, status: { id: "weixin", state: "off", qr: "", pairCode: "", pending: 0, error: "" } },
  { type: "connectorChanged", at: T0, status: { id: "weixin", state: "connected", qr: "", pairCode: "", pending: 0, error: "" } },
  { type: "machineChanged", at: T0, machine: { id: "here", name: "Mac", here: true, online: true, joinedAt: T0 } },
  { type: "machineChanged", at: T0, machine: { id: "here", name: "Mac", here: true, online: true, joinedAt: T0 } },
  { type: "machineChanged", at: T0, machine: { id: "here", name: "Mac", here: true, online: false, joinedAt: T0 } },
  { type: "callChanged", at: T0, state: "live", reason: "" },
  { type: "callChanged", at: T0, state: "live", reason: "" },
  { type: "mediaChanged", at: T0, jobs: [] },
]);

const closedChild = (n: number, parent: string, status: string, more: Record<string, unknown> = {}) => issueWith(n, status, [], { parent, closedAt: T0 + n * min, ...more });
scenario("families", [
  { type: "issueChanged", at: T0, issue: issueWith(20, "todo", [], { description: "the parent" }) },
  { type: "issueChanged", at: T0, issue: closedChild(21, "i20", "done", { delivered: "merged_into_parent" }) },
  { type: "issueChanged", at: T0, issue: issueWith(22, "backlog", [], { parent: "i20" }) },
  { type: "issueChanged", at: T0, issue: closedChild(22, "i20", "canceled", { canceled: "dismissed" }) },
  { type: "issueChanged", at: T0, issue: issueWith(30, "todo", [], { description: "conflicted parent", conflict: { base: "main", files: ["x.ts", "y.ts"] } }) },
  { type: "issueChanged", at: T0, issue: closedChild(31, "i30", "done", { delivered: "merged_into_parent" }) },
  { type: "issueChanged", at: T0, issue: issueWith(40, "todo", [], { lastRun: { startedAt: T0, outcome: "completed" } }) },
  { type: "issueChanged", at: T0, issue: issueWith(41, "todo", [], { lastRun: { startedAt: T0, endedAt: T0 + min, outcome: "failed" } }) },
  { type: "issueChanged", at: T0, issue: issueWith(42, "backlog", [], { rank: -1024 }) },
  { type: "issueChanged", at: T0, issue: issueWith(43, "backlog", [], { rank: 2048 }) },
  { type: "sessionChanged", at: T0, session: { ...worker("d1", "i43", { _tag: "working", since: T0, doing: { action: "read_file", label: "a" } }), refining: true } },
  { type: "issueRemoved", at: T0, id: "i41" },
  { type: "issueRemoved", at: T0, id: "i41" },
]);

scenario("reviewed_and_answers", [
  { type: "sessionChanged", at: T0, session: worker("w50", "i50", working(T0)) },
  { type: "issueChanged", at: T0, issue: issueWith(50, "todo", ["w50"], { reviewedAt: T0 + min }) },
  { type: "sessionReported", at: T0 + 2 * min, id: "w50", outcome: "completed", summary: "done", runs: 1, questions: [], checks: [] },
  { type: "sessionChanged", at: T0, session: worker("w51", "i51", working(T0)) },
  { type: "issueChanged", at: T0, issue: issueWith(51, "todo", ["w51"], { deliver: "answer" }) },
  { type: "sessionReported", at: T0 + 2 * min, id: "w51", outcome: "completed", summary: "no answer block", runs: 1, questions: [], checks: [] },
  { type: "sessionChanged", at: T0, session: worker("w52", "i52", working(T0)) },
  { type: "issueChanged", at: T0, issue: issueWith(52, "todo", ["w52"], { pullRequest: { url: "https://github.com/a/b/pull/1", number: 1, state: "open" } }) },
  { type: "sessionReported", at: T0 + 2 * min, id: "w52", outcome: "completed", summary: "pr open", runs: 1, phase: { _tag: "resting" }, questions: [], checks: [] },
  { type: "sessionChanged", at: T0, session: worker("w53", "i53", working(T0)) },
  { type: "issueChanged", at: T0, issue: issueWith(53, "todo", ["w53"], { findings: [{ id: "f1", text: "fix the test", at: T0, resolved: false }] }) },
  { type: "issueChanged", at: T0, issue: issueWith(54, "todo", [], { lastRun: { startedAt: T0, endedAt: T0 + min, outcome: "interrupted" }, assignments: [] }) },
  { type: "sessionChanged", at: T0, session: { ...worker("w55", "i55", { _tag: "closed", at: T0, closed: "merged" }) } },
]);

// What the issues say to helpers (modules/issue/prompts.ts, brief.ts): the board's briefs must say the same.
{
  const P = await import(`${VV}/apps/server/src/modules/issue/prompts.ts`);
  const B = await import(`${VV}/apps/server/src/modules/issue/brief.ts`);
  const picks = [
    { title: "加上打卡", description: "", criteria: [], deliver: "change" },
    { title: "加上打卡", description: "用户要一个打卡按钮。\n\n第二段", criteria: ["点一下就打卡", "cargo test 通过"], deliver: "change" },
    { title: "为什么慢", description: "打卡很慢", criteria: ["说清原因"], deliver: "answer" },
    { title: "开 PR", description: "", criteria: ["CI 绿"], deliver: "pull_request" },
  ];
  const constraints = [
    [undefined, []],
    [{ scope: ["src/a.ts", "src/b.ts"], check: "vp test", acceptance: true, frozen: [] }, ["test/a.test.ts"]],
    [{ scope: [], acceptance: false, frozen: [] }, ["x.test.ts"]],
  ];
  const drafts = [
    [{ title: "New issue", description: "", criteria: [] }, "拖卡还在调旧接口", "board", ""],
    [{ title: "T", description: "D", criteria: ["c"], questions: [{ question: "用哪个端口？", options: [] }] }, "8080", "", "早先的讨论"],
    [{ title: "T", description: "D", criteria: ["c"] }, "再短一点", "board", ""],
    [{ title: "T", description: "", criteria: ["c"] }, "", "", ""],
  ];
  writeFileSync(
    join(out, "prompts.json"),
    JSON.stringify(
      {
        issueBrief: picks.map((p) => ({ input: p, output: B.issueBrief(p) })),
        workConstraints: constraints.map(([c, frozen]) => ({ input: { constraints: c ?? null, frozen }, output: P.workConstraints(c, frozen) })),
        refinementBrief: drafts.map(([t, word, repo, discussion]) => ({ input: { ...t, word, repo, discussion }, output: P.refinementBrief(t, word, repo, discussion) })),
      },
      null,
      1,
    ) + "\n",
  );
  console.log("prompts: issueBrief, workConstraints, refinementBrief");
}
