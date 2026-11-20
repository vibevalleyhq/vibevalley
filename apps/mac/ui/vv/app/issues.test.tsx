// The issue pages through the bridge (fakeHost plays the Rust side): an
// issue at work with its steps, one to review and its close dialog, one
// asking, a todo, a family, the list view, the display menu, the new issue
// sheet and the keys. Pictures: issues.shots.test.tsx.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { withIssues } from "../fixtures/issues";
import { responses, state } from "../fixtures/workbench";
import { sampleChanges } from "../web/features/issue/model/issue.samples";
import { fakeHost } from "./fakeHost";

const fixture = withIssues({ state, responses });

async function start(route = "/issues", width = 1200) {
  const fake = fakeHost(fixture, { route });
  const app = await open("./main.tsx", { width, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  return { app, fake };
}

const ops = (fake: Awaited<ReturnType<typeof start>>["fake"]) => fake.calls.map((c) => c.op);

test("an issue at work: requirement, criteria, acts, its story and steps", async () => {
  const { app, fake } = await start("/issues/i32");
  expect(app.count("id:issue")).toBe(1);
  const texts = app.texts();
  for (const s of ["设置页按用途分组", "设置按四组排", "#32"]) expect(texts).toContain(s);
  expect(app.count("id:issue-requirement")).toBe(1);
  expect(app.count("id:criterion")).toBe(3);
  expect(app.count("id:act-tell")).toBe(1);
  expect(app.count("id:act-stop")).toBe(1);
  expect(app.count("id:milestone")).toBe(4);
  expect(ops(fake)).toContain("issue.timeline.get");
  // The steps are read when they are unfolded.
  expect(ops(fake)).not.toContain("session.event.list");
  await app.press("id:issue-steps-fold");
  await fake.pump(app);
  expect(ops(fake)).toContain("session.event.list");
  expect(app.count("id:issue-steps")).toBe(1);
  expect(app.texts()).toContain("vp test run src/base/session.test.ts");
});

test("regression: board and list show the same waiting thread as issue detail", async () => {
  const { app } = await start();
  expect(app.texts()).toContain("主线程在等「测试设置分组」");
  await app.press("id:issue-view-list");
  expect(app.texts()).toContain("主线程在等「测试设置分组」");
});

test("regression: a Codex subtask opens only its thread and run", async () => {
  const { app, fake } = await start("/issues/i32", 560);
  expect(app.texts()).toContain("主线程在等「测试设置分组」");
  expect(app.texts()).toContain("运行设置页测试");
  expect(ops(fake)).not.toContain("session.event.list");
  await app.press("id:subagent-test-settings");
  await fake.pump(app);
  expect(app.texts()).toContain("设置项分组用例通过");
  expect(app.texts()).not.toContain("自己起的一轮");
  expect(app.count("id:subagent-steps")).toBe(1);
  expect(app.texts()).toContain("运行设置页键盘用例");
  expect(app.texts()).toContain("未开始");
  expect(app.texts()).not.toContain("四组名称核对完毕");
  expect(app.texts()).not.toContain("旧轮用例通过");
  await app.press("id:subagent-review-groups");
  await fake.pump(app);
  expect(app.texts()).toContain("四组名称核对完毕");
  expect(app.count("id:subagent-steps")).toBe(0);
  expect(app.texts()).not.toContain("设置项分组用例通过");
  await app.press("id:subagent-review-groups");
  expect(app.count("id:subagent-log")).toBe(0);
});

test("regression: a retained subtask survives 240 unrelated log steps", async () => {
  const unrelated = Array.from({ length: 240 }, (_, seq) => ({
    seq,
    revision: 0,
    time: seq,
    run: "run-2",
    threadId: "other",
    type: "assistant/message",
    text: "Other thread output",
  }));
  const fake = fakeHost({ ...fixture, responses: { ...fixture.responses, "session.event.list": unrelated } }, { route: "/issues/i32" });
  const app = await open("./main.tsx", { width: 1200, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await app.press("id:subagent-test-settings");
  await fake.pump(app);
  expect(app.count("id:subagent-test-settings")).toBe(1);
  expect(app.texts()).toContain("运行设置页测试");
  expect(app.texts()).toContain("近期工作日志中暂无这条线程的步骤。");
  expect(app.texts()).not.toContain("Other thread output");
});

test("regression: a new server frame replaces a subtask wait and last observation", async () => {
  const { app, fake } = await start("/issues/i32");
  const state = fixture.state.state;
  const lost = state.sessions.map((session) =>
    session.subagents ? { ...session, subagents: { ...session.subagents, disconnectedAt: session.subagents.threads[0]?.updatedAt } } : session,
  );
  await fake.setState(app, { ...fixture.state, state: { ...state, sessions: lost } });
  expect(app.count("id:subagent-disconnected")).toBe(1);
  expect(app.texts()).toContain("中断前，主线程在等「测试设置分组」");
  expect(app.texts()).toContain("运行设置页测试");
  const sessions = state.sessions.map((session) => {
    if (session.id !== "w5" || !session.subagents) return session;
    return {
      ...session,
      subagents: {
        ...session.subagents,
        waits: [],
        threads: session.subagents.threads.map((thread) =>
          thread.threadId === "test-settings"
            ? { ...thread, status: "errored" as const, lastActivity: "设置测试失败", updatedAt: thread.updatedAt + 1000 }
            : thread,
        ),
      },
    };
  });
  await fake.setState(app, { ...fixture.state, state: { ...state, sessions } });
  expect(app.count("id:subagent-wait")).toBe(0);
  expect(app.count("id:subagent-disconnected")).toBe(0);
  expect(app.texts()).toContain("设置测试失败");
  expect(app.texts()).not.toContain("运行设置页测试");
  expect(ops(fake)).not.toContain("session.event.list");
});

test("regression: an untargeted Codex wait reports a mailbox and keeps the unnamed child identity", async () => {
  const { app, fake } = await start("/issues/i32");
  const state = fixture.state.state;
  const sessions = state.sessions.map((session) => {
    if (!session.subagents) return session;
    const { rootThreadId } = session.subagents;
    return {
      ...session,
      subagents: {
        ...session.subagents,
        waits: [{ threadId: rootThreadId, callId: "mailbox", targets: [] }],
        threads: [
          { threadId: "child-without-prompt", updatedAt: 1 },
          { threadId: "vendor-2", agentName: "/root/audit", lastAction: "run_command" as const, updatedAt: 2 },
        ],
      },
    };
  });
  await fake.setState(app, { ...fixture.state, state: { ...state, sessions } });
  expect(app.texts()).toContain("主线程在等协作消息");
  expect(app.texts()).toContain("child-without-prompt");
  expect(app.texts()).toContain("/root/audit");
  expect(app.texts()).toContain("跑命令");
  expect(app.texts()).not.toContain("主线程在等「child-without-prompt」");
});

test("regression: an earlier run keeps its subtask after a new run", async () => {
  const { app, fake } = await start("/issues/i31");
  expect(app.count("id:subagent-old-review")).toBe(0);
  await app.press("id:issue-runs-fold");
  await fake.pump(app);
  expect(app.count("id:subagent-old-review")).toBe(1);
  expect(app.texts()).toContain("复查登录提示");
  await app.press("id:subagent-old-review");
  await fake.pump(app);
  expect(app.texts()).toContain("近期工作日志中暂无这条线程的步骤。");
});

function recoveredFixture() {
  const state = fixture.state.state;
  const sessions = state.sessions.map((session) =>
    session.id === "w5"
      ? {
          ...session,
          phase: { _tag: "resting" as const },
          lastRun: { summary: "", at: 4, outcome: "interrupted" as const, needsReconciliation: true },
        }
      : session,
  );
  const issues = state.issues.map((issue) =>
    issue.id === "i32"
      ? {
          ...issue,
          status: "in_review" as const,
          stage: { ...issue.stage, state: "stuck" as const, stuck: "interrupted" as const },
        }
      : issue,
  );
  return { ...fixture, state: { ...fixture.state, state: { ...state, sessions, issues } } };
}

test("regression: the overview separates a question, a review and a worktree to verify", async () => {
  const recovered = recoveredFixture();
  const fake = fakeHost(recovered, { route: "/issues" });
  const app = await open("./main.tsx", { width: 1200, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  for (const label of ["等你回答", "等你验收", "需要核对工作目录"]) expect(app.texts()).toContain(label);
  await app.press("id:issue-view-list");
  for (const label of ["等你回答", "等你验收", "需要核对工作目录"]) expect(app.texts()).toContain(label);
  const state = recovered.state.state;
  const resumed = state.sessions.map((s) =>
    s.id === "w5"
      ? {
          ...s,
          phase: { _tag: "working" as const, since: 5, doing: { action: "thinking" as const, label: "", actionText: "" } },
        }
      : s,
  );
  await fake.setState(app, { ...recovered.state, state: { ...state, sessions: resumed } });
  expect(app.texts()).not.toContain("需要核对工作目录");
  expect(ops(fake)).not.toContain("issue.run.list");
});

test("regression: an interrupted run offers the current worktree diff only when reconciliation is requested", async () => {
  const earlier = { id: "previous", session: "w5", triggeredBy: { kind: "issue" }, heard: [], startedAt: 1, endedAt: 2, outcome: "interrupted", summary: "" };
  const latest = { ...earlier, id: "latest", startedAt: 3, endedAt: 4, needsReconciliation: true };
  const fake = fakeHost({ ...recoveredFixture(), responses: { ...fixture.responses, "issue.run.list": [earlier, latest] } }, { route: "/issues/i32" });
  const app = await open("./main.tsx", { width: 1200, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  expect(app.count("id:run-reconcile")).toBe(1);
  expect(app.texts()).toContain("需要核对工作目录");
  expect(app.count("id:changed-file")).toBe(0);
  await app.press("id:run-review-changes");
  expect(app.count("id:changed-file")).toBe(3);
  await app.press("id:issue-runs-fold");
  await fake.pump(app);
  expect(app.count("id:run-reconcile")).toBe(2);
});

test("tell opens a box under the acts", async () => {
  const { app } = await start("/issues/i32");
  await app.press("id:act-tell");
  expect(app.count("id:issue-tell")).toBe(1);
});

test("an issue to review: complete opens the close dialog on its changes", async () => {
  const { app, fake } = await start("/issues/i31");
  expect(app.count("id:criterion-tick")).toBe(3);
  expect(app.texts()).toContain("只测了过期前后各一秒");
  await app.press("id:act-complete");
  await fake.pump(app);
  expect(app.count("id:close-issue")).toBe(1);
  expect(app.count("id:changes-review")).toBe(1);
  expect(app.count("id:changed-file")).toBe(3);
  await app.press("label:apps/web/src/base/session.ts");
  expect(app.count("id:patch")).toBe(1);
});

test("regression: a changed review keeps the dialog open and reads the new patch before delivery", async () => {
  const revision = { baseCommit: "base", tree: "seen" };
  const updated = { path: "updated.txt", status: "M", added: 1, removed: 0 };
  let moved = false;
  const issue = fixture.state.state.issues.find((i) => i.id === "i31");
  const fake = fakeHost(
    {
      state: fixture.state,
      responses: {
        ...fixture.responses,
        "issue.diff.get": () => (moved ? { ...sampleChanges, revision: { ...revision, tree: "new" }, sinceReview: [updated] } : { ...sampleChanges, revision }),
        "issue.status.update": { ...issue, seq: 1 },
        "issue.review": () => {
          if (moved) return issue;
          moved = true;
          return { bizCode: 300001, message: "review changed" };
        },
      },
    },
    { route: "/issues/i31" },
  );
  const app = await open("./main.tsx", { width: 900, height: 700, platform: "macos", host: fake.options });
  await fake.pump(app);
  await app.press("id:act-complete");
  await fake.pump(app);
  await app.press("id:review-complete");
  await fake.pump(app);
  expect(fake.calls.find((call) => call.op === "issue.review")?.payload).toEqual({ id: "i31", pass: true, revision });
  expect(ops(fake)).not.toContain("issue.status.update");
  expect(fake.calls.findLast((call) => call.op === "issue.diff.get")?.payload).toEqual({ id: "i31", sinceTree: "seen" });
  expect(app.count("id:changes-since-review")).toBe(1);
  expect(app.texts()).toContain("updated.txt");
  await app.press("id:review-complete");
  await fake.pump(app);
  expect(fake.calls.findLast((call) => call.op === "issue.review")?.payload).toEqual({
    id: "i31",
    pass: true,
    revision: { baseCommit: "base", tree: "new" },
  });
  const completions = fake.calls.filter((call) => call.op === "issue.status.update");
  expect(completions.length).toBe(1);
  expect(completions[0]?.payload).toMatchObject({ id: "i31", status: "done", revision: { baseCommit: "base", tree: "new" } });
});

test("closing an issue asks first", async () => {
  const { app } = await start("/issues/i31");
  await app.press("id:act-close");
  expect(app.count("id:close-issue")).toBe(1);
  expect(app.count("id:review-changes")).toBe(1);
  await app.press("id:close-never");
  expect(app.count("id:close-issue")).toBe(0);
});

test("an asking issue: an option is the answer", async () => {
  const { app, fake } = await start("/issues/i33");
  expect(app.count("id:issue-ask")).toBe(1);
  expect(app.count("id:answer-option")).toBe(2);
  await app.press("text:回登录页");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "issue.comment.create")).toBe(true);
});

test("a todo opens as its draft", async () => {
  const { app } = await start("/issues/i22");
  expect(app.value("id:issue-title")).toBe("看板拖拽的手感");
  expect(app.count("id:issue-remove")).toBe(1);
  expect(app.count("id:issue-unqueue")).toBe(1);
});

test("a draft in the backlog talks first", async () => {
  const { app } = await start("/issues/i21");
  expect(app.count("id:issue-talk")).toBe(1);
  expect(app.count("id:issue-start")).toBe(1);
  await app.press("id:issue-write-own");
  expect(app.count("id:issue-description")).toBe(1);
});

test("a family lists its children, each opens", async () => {
  const { app, fake } = await start("/issues/i40");
  expect(app.count("id:issue-family")).toBe(1);
  expect(app.count("id:child-issue")).toBe(2);
  await app.press("label:记住我");
  await fake.pump(app);
  expect(app.value("id:issue-title")).toBe("记住我");
});

test("back to the board, by its link and by Escape", async () => {
  const { app, fake } = await start("/issues/i32");
  await app.press("id:issue-close");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(0);
  expect(app.count("id:lane-todo")).toBe(1);
  await app.press("label:设置页按用途分组");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(1);
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(0);
});

test("regression: a native route change opens and dismisses the new issue dialog", async () => {
  const { app, fake } = await start("/issues/i32");
  await app.host.send("route", "/issues/new?repo=vibevalley");
  await fake.pump(app);
  expect(app.count("id:issue-new-dialog")).toBe(1);
  await app.press("id:issue-new-dialog-never");
  await fake.pump(app);
  expect(app.count("id:issue-new-dialog")).toBe(0);
  expect(app.count("id:lane-todo")).toBe(1);
});
test("regression: Escape returns a narrow board to the lane and keyboard focus of its card", async () => {
  const { app, fake } = await start("/issues", 560);
  await app.press("id:board-lane-tab-working");
  await app.press("label:设置页按用途分组");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(1);
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(app.count("id:lane-working")).toBe(1);
  expect(app.count("id:lane-todo")).toBe(0);
  await app.keyboard.press("enter");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(1);
  expect(app.texts()).toContain("#32");
  expect(app.texts()).toContain("设置页按用途分组");
});

test("the list view groups the issues by status", async () => {
  const { app } = await start();
  await app.press("id:issue-view-list");
  expect(app.count("id:issue-list")).toBe(1);
  expect(app.count("id:issue-group")).toBe(4);
  expect(app.count("id:issue-card")).toBe(13);
  await app.press("id:display");
  expect(app.count("id:display-menu")).toBe(1);
  await app.press("id:grouping-repo");
  expect(app.count("id:display-reset")).toBe(1);
});

test("regression: a refused new issue keeps the draft and retries the same request", async () => {
  const issue = { ...fixture.state.state.issues[0], seq: fixture.state.seq + 1 };
  let accept = false;
  const fake = fakeHost(
    {
      state: fixture.state,
      responses: {
        ...fixture.responses,
        "issue.create": () => (accept ? issue : { bizCode: 300001, message: "Try again" }),
        "issue.refine": issue,
      },
    },
    { route: "/issues" },
  );
  const app = await open("./main.tsx", { width: 1200, height: 800, platform: "macos", host: fake.options });
  await fake.pump(app);
  await app.press("id:issue-new");
  expect(app.enabled("id:issue-new-keep")).toBe(false);
  await app.type("id:issue-new-text", "登录页加一个忘记密码");
  await app.press("id:issue-new-keep");
  await fake.pump(app);
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.enabled("id:issue-new-keep")).toBe(true);
  accept = true;
  await app.press("id:issue-new-keep");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:issue-new-dialog") === 0);
  const creates = fake.calls.filter((call) => call.op === "issue.create");
  expect(creates.length).toBe(2);
  expect(creates[1]?.payload).toEqual(creates[0]?.payload);
});

test("regression: an accepted request retains edits made while its reply was pending", async () => {
  const response = { ...fixture.state.state.issues[0], seq: fixture.state.seq + 1 };
  const fake = fakeHost(
    { state: fixture.state, responses: { ...fixture.responses, "issue.create": response, "issue.refine": response } },
    { route: "/issues/new?repo=vibevalley&from=map" },
  );
  const app = await open("./main.tsx", { width: 560, height: 760, platform: "macos", host: fake.options });
  await fake.pump(app);
  await app.type("id:issue-new-text", "First");
  await app.press("id:issue-new-keep");
  await app.type("id:issue-new-text", "Changed");
  const edited = app.value("id:issue-new-text");
  await fake.pump(app);
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.value("id:issue-new-text")).toBe(edited);
  expect(app.texts()).toContain("刚才的内容已提交，修改后的草稿已保留。");
  await app.press("id:issue-new-keep");
  await fake.pump(app);
  const writes = fake.calls.filter((c) => c.op === "issue.create").map((c) => c.payload as { title: string; requestKey: string });
  expect(writes.map((w) => w.title)).toEqual(["First", edited]);
  expect(writes[0]?.requestKey).not.toBe(writes[1]?.requestKey);
  expect(app.count("id:issue-new-dialog")).toBe(0);
});

test("regression: choosing another repository or agent gives a rejected draft a new key", async () => {
  const fake = fakeHost(
    { state: fixture.state, responses: { ...fixture.responses, "issue.create": { bizCode: 300001, message: "Try again" } } },
    { route: "/issues/new?repo=vibevalley&agent=laozhou" },
  );
  const app = await open("./main.tsx", { width: 1200, height: 800, platform: "macos", host: fake.options });
  await fake.pump(app);
  await app.type("id:issue-new-text", "same input");
  const save = async () => {
    await app.press("id:issue-new-keep");
    await fake.pump(app);
    expect(app.count("id:issue-new-dialog")).toBe(1);
  };
  await save();
  await app.press("id:issue-new-repo-trigger");
  await app.press("text:site");
  await save();
  await app.press("id:issue-new-helper-trigger");
  await app.press("text:小林");
  await save();
  const writes = fake.calls.filter((c) => c.op === "issue.create").map((c) => c.payload as { repo: string; agent: string; requestKey: string });
  expect(writes.map((w) => [w.repo, w.agent])).toEqual([
    ["vibevalley", "laozhou"],
    ["site", "laozhou"],
    ["site", "xiaolin"],
  ]);
  expect(new Set(writes.map((w) => w.requestKey)).size).toBe(3);
});

test("regression: Escape cancels a focused map draft", async () => {
  const { app, fake } = await start("/map", 560);
  await app.host.send("route", "/issues/new?repo=vibevalley");
  await fake.pump(app);
  await app.type("id:issue-new-text", "unfinished");
  await app.keyboard.press("escape");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:repo-map") === 1);
  expect(app.count("id:issue-new-dialog")).toBe(0);
  expect(fake.calls.filter((c) => c.op === "issue.create").length).toBe(0);
});

test("regression: Escape returns from a plot issue to the map that opened it", async () => {
  const { app, fake } = await start("/map");
  await app.host.send("route", "/issues/i32");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(1);
  await app.keyboard.press("escape");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:repo-map") === 1);
  expect(fake.acts.filter((a) => a.type === "openRepoMap").length).toBe(2);
});

test("C writes a new issue on the board, not on an issue", async () => {
  const { app, fake } = await start();
  await app.keyboard.press("c");
  expect(app.count("id:issue-new-dialog")).toBe(1);
  await app.press("id:issue-new-dialog-never");
  await app.press("label:设置页按用途分组");
  await fake.pump(app);
  await app.keyboard.press("c");
  expect(app.count("id:issue-new-dialog")).toBe(0);
});

test("dragging a todo with its helper and repo into the working lane starts it; onto another todo places it before", async () => {
  const { app, fake } = await start();
  await app.dragAndHold("text:看板拖拽的手感", { x: 270, y: 0 });
  expect(app.count("id:drag-ghost")).toBe(1);
  await app.drop();
  await fake.pump(app);
  expect(app.count("id:drag-ghost")).toBe(0);
  const moved = fake.calls.filter((c) => c.op.startsWith("issue.") && JSON.stringify(c.payload).includes("i22"));
  expect(moved.length).toBeGreaterThan(0);
  await app.drag("text:灵动岛的动画", { x: 0, y: -60 });
  await fake.pump(app);
  const placed = fake.calls.find((c) => c.op === "issue.update" && (c.payload as { before?: string }).before !== undefined);
  expect(placed?.payload).toMatchObject({ id: "i23" });
});
