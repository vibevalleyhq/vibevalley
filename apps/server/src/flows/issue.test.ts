import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { assignedAgentOf, executionsOf, isBusy, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { user } from "#/base/actor.ts";
import { viewOf } from "#/modules/game/view.ts";
import { openFindings } from "#/modules/issue/status.ts";
import { HireRefused } from "#/modules/session/session.ts";
import { write } from "#/testing/git.ts";
import { shiftedTime } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";
import { helper } from "#/testing/worker.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, git, lab, mustHire, until, watch, failure } from "./farm.ts";

const refusedWith = (e: unknown, words = "") => {
  const tagged = e as { _tag?: string; bizCode?: unknown; reason?: string };
  expect(tagged.bizCode).toBe(BizCode.IssueRefused);
  if (words) expect(tagged.reason).toContain(words);
};

const latest = (issue: T.Issue) => {
  const id = latestSessionIdOf(issue);
  if (id === undefined) throw new Error("the issue has no execution session");
  return id;
};

const withCron = (issues: readonly T.Issue[], cron: string) => {
  const issue = issues.find((item) => item.cron === cron);
  if (!issue) throw new Error("the cron has no issue");
  return issue;
};

describe("an issue", () => {
  // Done is the user's verdict.
  test("completes by what it delivers: nothing, a kept branch, or a merge", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    await fw.agent.save(lab());
    const repo = join(f.config.workRoot, "repos", "clock");
    const closed = (id: string) =>
      await_(
        () => issues.get(id),
        (i) => i.closedAt !== undefined,
        "closed",
      );
    const left = (id: string) =>
      await_(
        () => sessions.get(id),
        (s) => s?.phase._tag === "closed",
        "gone home",
      );
    const mainLog = () => git(repo, "log", "--format=%s", "main");

    const hired = await issues.hire(lab(), "看看打卡页", "clock");
    const looked = mustHire(hired);
    await w.nextReport();
    const before = mainLog();
    await issues.setStatus(looked.issue!, "done", "", "", user);
    const nothing = await closed(looked.issue!);
    expect([nothing.status, nothing.delivered, nothing.canceled]).toEqual(["done", "none", undefined]);
    const gone = await left(looked.id);
    expect(gone?.phase._tag === "closed" && gone.phase.closed).toBe("completed");
    expect(mainLog()).toBe(before);

    const hired2 = await issues.hire(lab(), "写打卡并提交", "clock");
    const kept = mustHire(hired2);
    await w.nextReport();
    const keptIssue = await issues.get(kept.issue!);
    await issues.edit(kept.issue!, { deliver: "branch" }, user);
    await issues.setStatus(kept.issue!, "done", "", "", user);
    expect((await closed(kept.issue!)).delivered).toBe("kept");
    await left(kept.id);
    expect(mainLog()).toBe(before);
    expect(git(repo, "branch", "--list", `vibevalley/issue-${keptIssue.number}`)).not.toBe("");

    const hired3 = await issues.hire(lab(), "写打卡并提交", "clock");
    const completed = mustHire(hired3);
    await w.nextReport();
    await issues.setStatus(completed.issue!, "done", "", "", user);
    expect((await closed(completed.issue!)).delivered).toBe("merged");
    expect(mainLog()).not.toBe(before);
  });

  test("closes and reopens", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    const sql = sqlOf(fw.db);
    await fw.agent.save(lab());
    const hired = await issues.hire(lab(), "写打卡并提交", "clock-in");
    const session = mustHire(hired);
    expect(session.issue).toBeTruthy();
    await w.nextReport();
    const setStatusFailure = await failure(issues.setStatus(session.id, "todo", "", "", user));
    refusedWith(setStatusFailure);
    await issues.setStatus(session.issue!, "done", "", "", user);
    const ended = (await sessions.get(session.id))!;
    expect([ended.phase._tag === "closed" && ended.phase.closed, ended.lastRun?.outcome, !!ended.lastRun?.summary, ended.runs, ended.issue]).toEqual([
      "merged",
      "completed",
      true,
      1,
      session.issue,
    ]);
    const closedAs = (how: string) =>
      await_(
        () => issues.get(session.issue!),
        (i) => (i.delivered ?? i.canceled) === how,
        `closed as ${how}`,
      );
    await closedAs("merged");

    const setStatus2 = await issues.setStatus(session.id, "todo", "打卡还要记下时区", "", user);
    const again = latest(setStatus2);
    await w.nextReport();
    const issue = await issues.get(again);
    expect([issue.id, sessionIdsOf(issue), issue.delivered, issue.canceled, issue.closedAt]).toEqual([
      session.issue,
      [session.id, again],
      undefined,
      undefined,
      undefined,
    ]);
    const reopened = (await sessions.get(again))!;
    expect(reopened.brief).toMatch(new RegExp(`^打卡还要记下时区\\n\\n（这张工单重开了，上一次是 .+（${session.id}）做的。）`, "u"));
    expect(reopened.brief).toMatch(/这张工单原来是：写打卡并提交\n它是怎么关的：已完成，合进了主分支/u);
    const setStatusFailure2 = await failure(issues.setStatus(session.issue!, "todo", "", "", user));
    refusedWith(setStatusFailure2);
    expect((await failure(issues.setStatus("w404", "todo", "", "", user))).bizCode).toBe(BizCode.IssueNotFound);
    await sessions.dismiss(again);
    await closedAs("dismissed");
    await sql`update issue set delivered = 'merged_into_parent', canceled = null, closed_at = ${Date.now()} where id = ${issue.id}`;
    const setStatusFailure3 = await failure(issues.setStatus(issue.id, "todo", "", "", user));
    refusedWith(setStatusFailure3, "计划里的工单");
  });

  test("reopens an issue run in the profile's own folder, which has no repo and so no branch", async () => {
    const f = farm({ repos: ["board"] });
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const me = { ...lab(), workdir: "board" };
    await fw.agent.save(me);
    const issue = await issues.add({ title: "看看", agent: me.id });
    await issues.setStatus(issue.id, "todo", "", "", user);
    await w.nextReport();
    expect((await issues.get(issue.id)).repo ?? "").toBe("");
    await issues.setStatus(issue.id, "canceled", "", "", user);
    const again = await issues.setStatus(issue.id, "todo", "再看看", "", user).then(
      () => "Success",
      () => "Failure",
    );
    expect(again).toBe("Success");
    await w.nextReport();
  });

  test("written down is started, edited, and ordered", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    const core = fw.core;
    await fw.agent.save(lab());
    const addedFailure = await failure(issues.add({ title: "  " }));
    refusedWith(addedFailure);
    let issue = await issues.add({ title: "写打卡并提交" });
    expect(issue.status).toBe("backlog");
    const inState = (id: string) => core.state().issues.find((x) => x.id === id);
    expect(inState(issue.id)?.title).toBe("写打卡并提交");
    const startedFailure = await failure(issues.start(issue.id, ""));
    refusedWith(startedFailure);
    issue = await issues.edit(issue.id, { repo: "backlog", agent: "lab" }, user);
    expect([issue.repo, assignedAgentOf(issue)]).toEqual(["backlog", "lab"]);
    const got = await issues.start(issue.id, "");
    expect(got.session).toBeDefined();
    await w.nextReport();
    expect((await sessions.get(got.session!))!.brief).toBe("写打卡并提交");
    const started = await issues.get(issue.id);
    expect([sessionIdsOf(started), started.status]).toEqual([[got.session], "in_review"]);
    await until(() => {
      const current = inState(issue.id);
      return current !== undefined && executionsOf(current).length === 1 && current.status === "in_review";
    }, "the core state follows its run");
    const startedFailure2 = await failure(issues.start(issue.id, ""));
    refusedWith(startedFailure2);
    const relabeled = await issues.edit(issue.id, { title: "写打卡", priority: "high" }, user);
    expect([relabeled.title, relabeled.priority]).toEqual(["写打卡", "high"]);
    expect((await sessions.get(got.session!))!.brief).toBe("写打卡并提交");
    const editedFailure = await failure(issues.edit(issue.id, { description: "改不了了" }, user));
    refusedWith(editedFailure);

    const unsent = (all: T.Issue[]) => all.filter((i) => executionsOf(i).length === 0).map((i) => i.title);
    const a = await issues.add({ title: "一" });
    const b = await issues.add({ title: "二", priority: "urgent" });
    const c = await issues.add({ title: "三" });
    expect([a.priority, b.priority]).toEqual(["medium", "urgent"]);
    await issues.edit(c.id, { before: a.id }, user);
    const issues2 = await issues.list();
    expect(unsent(issues2)).toEqual(["三", "一", "二"]);
    await issues.edit(c.id, { before: "" }, user);
    const issues3 = await issues.list();
    expect(unsent(issues3)).toEqual(["一", "二", "三"]);
    const d = await issues.add({ title: "四" });
    const all = await issues.list();
    expect(unsent(all)[3]).toBe(d.title);
    expect(all.at(-1)!.id).toBe(issue.id);
  });

  test("waits for room", async () => {
    const f = farm({ change: (c) => ({ ...c, repo: { ...c.repo, maxSessions: 1 } }) });
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    const core = fw.core;
    await fw.agent.save(lab());
    core.apply({
      type: "sessionChanged",
      session: {
        id: "w90",
        role: "worker",
        name: "占地的",
        agent: "lab",
        runtime: "pi",
        brief: "先干着",
        repo: "queue",
        hiredAt: 0,
        runs: 0,
        phase: { _tag: "working", since: Date.now(), doing: { action: "none", label: "" } },
        refining: false,
      } as T.Session,
    });
    const issue = await issues.add({ title: "等空位的活", repo: "queue", agent: "lab" });
    const got = await issues.start(issue.id, "");
    expect(got.session).toBeUndefined();
    expect(got.queued).toContain("排上队了");
    const status = async () => (await issues.get(issue.id)).status;
    const status2 = await status();
    expect(status2).toBe("todo");
    await fw.issue.refreshQueue();
    const status3 = await status();
    expect(status3).toBe("todo");
    const other = await issues.add({ title: "别排了", repo: "queue", agent: "lab" });
    const queued = await issues.setStatus(other.id, "todo", "", "", user);
    const unqueued = await issues.setStatus(other.id, "backlog", "", "", user);
    expect([queued.queuedAt !== undefined, unqueued.queuedAt]).toEqual([true, undefined]);
    core.apply({ type: "sessionLeft", id: sessionId("w90") });
    await fw.issue.refreshQueue();
    await w.nextReport();
    const status4 = await status();
    expect(status4).toBe("in_review");
    expect((await sessions.list("lab")).some((s) => s.brief === "等空位的活")).toBe(true);
  });

  test("regression: cron inputs wait for human review and reopen the same completed issue", async () => {
    const clock = shiftedTime();
    const f = farm({ clock });
    await using fw = await f.open();
    const w = watch(fw);
    const issue = fw.issue;
    const issues = testIssues(issue);
    const crons = fw.issue;
    await fw.agent.save({ ...lab(), enabled: true });
    const made = await crons.addCron(
      {
        name: "巡检",
        text: "看一眼",
        agent: "lab",
        repo: "every",
        when: { kind: "every", minutes: 5 },
      },
      user,
    );
    const due = async () => {
      clock.adjust(5 * 60_000 + 1);
      await crons.tickCrons();
      await fw.intake.replay();
    };
    const ofCron = async () => withCron(await issues.list(), made.id);
    const runs = async () => fw.intake.runsOf((await ofCron()).id);
    await due();
    await w.nextReport();
    const first = await ofCron();
    expect(sessionIdsOf(first)).toHaveLength(1);
    expect(f.turns[0]!.input).toContain("vv://trigger/");

    await due();
    expect((await ofCron()).id).toBe(first.id);
    const ofCron2 = await ofCron();
    expect(sessionIdsOf(ofCron2)).toHaveLength(1);
    const runs2 = await runs();
    expect(runs2).toHaveLength(1);
    const sql = sqlOf(fw.db);
    const held = await sql.unsafe<{ state: string }>("select state from issue_input where issue_id = $1 and state = 'held'", [first.id]);
    expect(held).toHaveLength(1);

    await issues.setStatus(first.id, "done", "", "", user);
    await await_(ofCron, (i) => i.status === "done", "merged");
    await due();
    await w.nextReport();
    expect((await ofCron()).id).toBe(first.id);
    const ofCron3 = await ofCron();
    expect(sessionIdsOf(ofCron3)).toHaveLength(2);
    const two = await await_(runs, (r) => r.length === 2, "a second run");
    expect(two[1]!.triggeredBy.kind).toBe("cron");
  });

  test("update changes only what it gives", async () => {
    const f = farm();
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    let issue = await issues.add({
      title: "写打卡",
      description: "每天一次",
      repo: "demo",
      agent: "lab",
      priority: "high",
    });
    issue = await issues.edit(issue.id, { title: "写打卡并提交" }, user);
    expect([issue.title, issue.description, issue.repo, assignedAgentOf(issue), issue.priority]).toEqual(["写打卡并提交", "每天一次", "demo", "lab", "high"]);
    issue = await issues.edit(issue.id, { repo: "" }, user);
    expect([issue.repo, assignedAgentOf(issue)]).toEqual([undefined, "lab"]);
  });

  // The user only moves the issue: todo sends it out, todo again is another round, done merges; the dropped one comes back.
  test("is worked by moving it", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    await fw.agent.save(lab());
    const move = (id: string, to: T.Issue["status"], text = "") => issues.setStatus(id, to, text, "", user);
    let issue = await issues.add({ title: "写打卡并提交", repo: "clock", agent: "lab" });
    expect(issue.moves).toEqual(["todo", "canceled"]);
    const movedFailure = await failure(move(issue.id, "in_progress"));
    refusedWith(movedFailure);
    issue = await move(issue.id, "todo");
    await w.nextReport();
    issue = await issues.get(issue.id);
    expect([issue.status, issue.moves]).toEqual(["in_review", ["todo", "done", "canceled"]]);
    const movedFailure2 = await failure(move(issue.id, "todo", " "));
    refusedWith(movedFailure2);
    await move(issue.id, "todo", "再写版本B");
    await w.nextReport();
    issue = await move(issue.id, "done");
    expect(issue.status).toBe("done");
    expect(git(join(f.config.workRoot, "repos", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/u);
    expect(issue.moves).toEqual(["todo"]);

    let dropped = await issues.add({ title: "算了" });
    dropped = await move(dropped.id, "canceled");
    expect([dropped.status, dropped.canceled]).toEqual(["canceled", "dismissed"]);
    dropped = await move(dropped.id, "backlog");
    expect(dropped.status).toBe("backlog");
  });

  test("moved to done is refused when the repo's check fails", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    await fw.agent.save(lab());
    const hired = await issues.hire(lab(), "写打卡并提交", "clock");
    const helper = mustHire(hired);
    await w.nextReport();
    const cwd = sessions.cwdOf(helper.id)!;
    mkdirSync(join(cwd, ".vibevalley"), { recursive: true });
    write(join(cwd, ".vibevalley/check"), "#!/bin/sh\necho merge-check-failed\nexit 1\n", 0o755);
    git(cwd, "add", ".vibevalley/check");
    git(cwd, "commit", "-qm", "the check that fails");
    const repo = join(f.config.workRoot, "repos", "clock");
    const before = git(repo, "rev-parse", "main");
    const setStatusFailure = await failure(issues.setStatus(helper.issue!, "done", "", "", user));
    refusedWith(setStatusFailure, "merge-check-failed");
    // Not done; the helper is already told what failed (issue/merge.ts notTaken) and may be at it (in_progress).
    expect((await issues.get(helper.issue!)).status).not.toBe("done");
    await until(() => {
      const got = sessions.sessionOf(helper.id);
      return got !== undefined && sessions.lastTextOf(helper.id).includes("merge-check-failed") && !isBusy(got);
    }, "the helper hears the check's output");
    expect((await issues.get(helper.issue!)).status).toBe("in_review");
    expect(git(repo, "rev-parse", "main")).toBe(before);
    expect(existsSync(cwd)).toBe(true);
    git(repo, "rev-parse", "--verify", helper.branch!);
  });

  test("keeps its worktree when cancelled and reopened", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const sessions = fw.inside;
    await fw.agent.save(lab());
    const issue = await issues.add({
      title: "写打卡并提交",
      repo: "resume",
      agent: "lab",
    });
    const sent = await issues.start(issue.id, "");
    await w.nextReport();
    const first = (await sessions.get(sent.session!))!;
    expect(first.branch).toBe(`vibevalley/issue-${issue.number}`);
    const before = git(first.worktree!, "rev-parse", "HEAD");
    await sessions.dismiss(first.id);
    await await_(
      () => issues.get(issue.id),
      (i) => i.closedAt !== undefined,
      "cancelled",
    );
    const resumed = await issues.setStatus(issue.id, "todo", "接着做", "", user);
    let again = latest(resumed);
    await w.nextReport();
    const reopened = (await sessions.get(again))!;
    expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
    expect(git(reopened.worktree!, "rev-parse", "HEAD")).toBe(before);
    expect(reopened.brief).toContain("这条分支上已经有上次的提交，接着做。");
    await issues.setStatus(issue.id, "done", "", "", user);
    await await_(
      () => issues.get(issue.id),
      (i) => i.delivered === "merged",
      "merged",
    );
    const setStatus2 = await issues.setStatus(issue.id, "todo", "再看看", "", user);
    again = latest(setStatus2);
    await w.nextReport();
    expect((await sessions.get(again))!.brief).not.toContain("这条分支上已经有上次的提交，接着做。");
  });

  test("moves as the issue's buttons say", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const { in: saidIn } = fw.said;
    const chat = fw.channel;
    await fw.agent.save(lab());
    const drop = await issues.add({ title: "先放着", repo: "acts", agent: "lab" });
    const dropped = await issues.setStatus(drop.id, "canceled", "", "", user);
    expect([dropped.status, dropped.stage.acts]).toEqual(["canceled", [{ act: "reopen", does: "move", status: "backlog", words: "none" }]]);
    // Never sent: a reopen is back to the backlog, with nothing to tell.
    expect((await issues.setStatus("#" + drop.number, "backlog", "", "", user)).status).toBe("backlog");

    const issue = await issues.add({ title: "这一单必败", repo: "acts", agent: "lab" });
    await issues.setStatus(issue.id, "todo", "", "", user);
    await w.nextReport();
    await await_(
      () => issues.get(issue.id),
      (i) => i.stage.stuck === "failed",
      "stuck: failed",
    );
    const setStatusFailure = await failure(issues.setStatus(issue.id, "done", "", "", user));
    refusedWith(setStatusFailure, "这一轮没做成");
    expect((await issues.get(issue.id)).stage.acts[0]).toEqual({ act: "cure", does: "move", status: "todo", words: "none" });
    await issues.setStatus(issue.id, "todo", "", "", user);
    const issue3 = await issues.get(issue.id);
    const running = latestSessionIdOf(issue3);
    if (running === undefined) throw new Error("the issue has no execution session");
    const thread = (await chat.homeOf(running))!;
    await until(
      () => saidIn(thread).some((m) => m.from === "user" && m.text === "接着修：这一单必败。看一下报错，修好再跑一遍测试"),
      "the cure said once, by the server",
    );
  });

  test("regression: a dry run reads an unsaved agent through an Assignment", async () => {
    const f = farm();
    await using fw = await f.open();
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "先选人再开工" });
    const preview = await issues.previewStatus(issue.id, "todo", "", {}, { agent: "lab" });
    expect(preview.does.join("\n")).toContain(lab().name);
    expect((await issues.get(issue.id)).assignments).toEqual([]);
  });

  // A dry run of a move says what it would do, from the same judgment as the move, and changes nothing: no git, no status.
  test("says what completing would deliver before it is done, and then does that", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    await fw.agent.save(lab());
    const repo = join(f.config.workRoot, "repos", "clock");
    const hired = await issues.hire(lab(), "写打卡并提交", "clock");
    const committed = mustHire(hired);
    await w.nextReport();
    const before = git(repo, "log", "--format=%s", "main");
    const merging = await issues.previewStatus(committed.issue!, "done", "");
    expect(merging.does.at(-1)).toMatch(/^合进 main（1 个提交），关成已完成，/u);
    const keeping = await issues.previewStatus(committed.issue!, "done", "", {}, { deliver: "branch" });
    expect(keeping.does[0]).toMatch(/关成已完成：分支留着没合（1 个提交）$/u);
    expect([git(repo, "log", "--format=%s", "main"), (await issues.get(committed.issue!)).status]).toEqual([before, "in_review"]);
    await issues.setStatus(committed.issue!, "done", "", "", user);
    const done = await await_(
      () => issues.get(committed.issue!),
      (i) => i.closedAt !== undefined,
      "done",
    );
    expect(done.delivered).toBe("merged");

    const hired2 = await issues.hire(lab(), "看看打卡页", "clock");
    const looked = mustHire(hired2);
    await w.nextReport();
    expect((await issues.previewStatus(looked.issue!, "done", "")).does[0]).toMatch(/关成已完成：没有改动要合$/u);
    expect((await issues.previewStatus(looked.issue!, "canceled", "")).does[0]).toMatch(/关成已取消$/u);
    const previewStatusFailure = await failure(issues.previewStatus(looked.issue!, "todo", ""));
    refusedWith(previewStatusFailure, "要说一句");
  });

  // An answer issue is read only: its conclusion is read into the issue, whatever the round changed goes, and completing it delivers nothing.
  test("answers with a conclusion and leaves nothing on its branch", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const turns: NonNullable<Parameters<typeof helper>[0]> = [];
    const f = farm({ runtime: helper(turns, async (_turn, _input, n) => gates[n]?.promise ?? Promise.resolve()) });
    await using fw = await f.open();
    const w = watch(fw);
    const issue = fw.issue;
    const issues = testIssues(issue);
    const sessions = fw.inside;
    const { in: saidIn } = fw.said;
    const chat = fw.channel;
    await fw.agent.save(lab());
    const repo = join(f.config.workRoot, "repos", "clock");
    const asked = await issues.add({
      title: "查一下打卡为什么慢，顺手提交",
      repo: "clock",
      agent: "lab",
      deliver: "answer",
    });
    expect(asked.deliver).toBe("answer");
    await issues.setStatus(asked.id, "todo", "", "", user);
    await until(() => turns.length >= 1, "the answer run");
    const issue2 = await issues.get(asked.id);
    const firstSession = latestSessionIdOf(issue2)!;
    await sessions.report(firstSession, {
      summary: "查清楚了",
      questions: [],
      checks: [],
      remember: [],
      prSubmit: false,
      answer: {
        conclusion: "打卡慢是因为每次都重读配置",
        evidence: ["clock.ts:1 每次调用都读一遍配置"],
        unsure: [],
        next: ["把配置读一次缓存起来"],
      },
    });
    gates[0]!.resolve();
    await w.nextReport();
    const answered = await await_(
      () => issues.get(asked.id),
      (i) => i.answer !== undefined && i.stage.state === "reviewing",
      "its conclusion",
    );
    expect(answered.answer).toEqual({
      conclusion: "打卡慢是因为每次都重读配置",
      evidence: ["clock.ts:1 每次调用都读一遍配置"],
      unsure: [],
      next: ["把配置读一次缓存起来"],
    });
    expect(answered.stage.acts.map((a) => a.act)).toEqual(["acknowledge", "reject", "tell", "close"]);
    const branch = `vibevalley/issue-${answered.number}`;
    await until(() => git(repo, "rev-parse", branch) === git(repo, "rev-parse", "main"), "what it committed gone");
    await issues.setStatus(asked.id, "done", "", "", user);
    const done = await await_(
      () => issues.get(asked.id),
      (i) => i.closedAt !== undefined,
      "done",
    );
    expect([done.status, done.delivered, done.answer?.conclusion]).toEqual(["done", "none", "打卡慢是因为每次都重读配置"]);

    const garbled = await issues.add({
      title: "查一下 乱写",
      repo: "clock",
      agent: "lab",
      deliver: "answer",
    });
    await issues.setStatus(garbled.id, "todo", "", "", user);
    await until(() => turns.length >= 2, "the unstructured answer run");
    gates[1]!.resolve();
    await w.nextReport();
    const stuck = await await_(
      () => issues.get(garbled.id),
      (i) => i.stage.stuck === "failed",
      "stuck: no answer read",
    );
    expect([stuck.answer, stuck.moves]).toEqual([undefined, ["todo", "canceled"]]);
    const setStatusFailure = await failure(issues.setStatus(garbled.id, "done", "", "", user));
    refusedWith(setStatusFailure, "这一轮没做成");
    await issues.setStatus(garbled.id, "todo", "", "", user);
    const running = latestSessionIdOf(stuck);
    if (running === undefined) throw new Error("the issue has no execution session");
    const thread = (await chat.homeOf(running))!;
    await until(
      () => saidIn(thread).some((m) => m.from === "user" && m.text.startsWith("接着修：上一轮交回的结论读不出来（没有通过 issue_report")),
      "what was wrong with it, said",
    );
    await until(() => turns.length >= 3, "the corrected answer run");
    await sessions.report(running, {
      summary: "查清楚了",
      questions: [],
      checks: [],
      remember: [],
      prSubmit: false,
      answer: {
        conclusion: "打卡慢是因为每次都重读配置",
        evidence: ["clock.ts:1 每次调用都读一遍配置"],
        unsure: [],
        next: ["把配置读一次缓存起来"],
      },
    });
    gates[2]!.resolve();
    await w.nextReport();
    await await_(
      () => issues.get(garbled.id),
      (i) => i.answer !== undefined && i.stage.state === "reviewing",
      "answered the second time",
    );
  });

  // Done is what was asked for, not how a round ended: a round that failed is not completed, whoever asks.
  test("does not complete a round that failed", async () => {
    const f = farm();
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    await fw.agent.save(lab());
    const issue = await issues.add({ title: "这一单必败", repo: "fails", agent: "lab" });
    await issues.setStatus(issue.id, "todo", "", "", user);
    await w.nextReport();
    const failed = await await_(
      () => issues.get(issue.id),
      (i) => i.stage.stuck === "failed",
      "stuck: failed",
    );
    expect(failed.status).toBe("in_progress");
    expect(failed.moves).toEqual(["todo", "canceled"]);
    const setStatusFailure = await failure(issues.setStatus(issue.id, "done", "", "", user));
    refusedWith(setStatusFailure, "这一轮没做成");
    const setStatusFailure2 = await failure(issues.setStatus(issue.id, "done", "", "", user));
    refusedWith(setStatusFailure2, "这一轮没做成");
    expect((await issues.get(issue.id)).closedAt).toBeUndefined();
  });

  // A question in a report leaves the plot short of fertilizer until the user answers.
  test("grows through its acceptance", async () => {
    const first = Promise.withResolvers<void>();
    const turns: NonNullable<Parameters<typeof helper>[0]> = [];
    const f = farm({ runtime: helper(turns, async (_turn, _input, n) => (n === 0 ? first.promise : Promise.resolve())) });
    await using fw = await f.open();
    const w = watch(fw);
    const issue2 = fw.issue;
    const issues = testIssues(issue2);
    const core = fw.core;
    const sessions = fw.inside;
    await fw.agent.save(lab());
    let issue = await issues.add({
      title: "先问清楚，再写打卡并提交",
      repo: "clock",
      agent: "lab",
    });
    await issues.setStatus(issue.id, "todo", "", "", user);
    await until(() => turns.length >= 1, "the asking run");
    const issue3 = await issues.get(issue.id);
    const firstSession = latestSessionIdOf(issue3)!;
    await sessions.report(firstSession, {
      summary: "需要端口",
      questions: [{ question: "用 8787 还是 8797？", options: [] }],
      checks: [],
      remember: [],
      prSubmit: false,
    });
    first.resolve();
    await w.nextReport();
    issue = await await_(
      () => issues.get(issue.id),
      (i) => i.questions.length === 1,
      "its question kept",
    );
    expect(issue.questions).toEqual([{ question: "用 8787 还是 8797？", options: [] }]);
    const crop = () => viewOf(core.state()).plots[issue.id]?.crop;
    await until(() => crop() === "dry", "the plot waiting on an answer");

    await issues.comment(issue.id, "用 8797");
    await await_(
      () => issues.get(issue.id),
      (i) => i.questions.length === 0,
      "answered",
    );
    await w.nextReport();
    await await_(
      () => issues.get(issue.id),
      (i) => i.status === "in_review",
      "handed back",
    );
    await until(() => crop() === "flowering", "抽穗：等验收");

    await issues.setStatus(issue.id, "todo", "再写版本B", "", user);
    const issue4 = await issues.get(issue.id);
    expect(openFindings(issue4)).toBe(1);
    await w.nextReport();
    await await_(
      () => issues.get(issue.id),
      (i) => i.status === "in_review",
      "the weed worked on and handed back",
    );
    // Handed back again it waits on the user's acceptance, as its page says; the findings stay open until a pass.
    await until(() => crop() === "flowering", "waiting on the acceptance again");
    const issue5 = await issues.get(issue.id);
    expect(openFindings(issue5)).toBe(1);

    issue = await issues.setStatus(issue.id, "done", "", "", user);
    expect([issue.status, openFindings(issue)]).toEqual(["done", 0]);
    expect(git(join(f.config.workRoot, "repos", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/u);
  });

  test("is not sent when the money runs out", async () => {
    let usage: T.AccountUsage | null = null;
    const f = farm({ usage: () => usage });
    await using fw = await f.open();
    const issues = fw.issue;
    const agents = fw.agent;
    const hire = () =>
      issues.hire(lab(), "随便做点什么", "money").then(
        () => "",
        (e: unknown) => {
          if (e instanceof HireRefused) return e.reason;
          throw e;
        },
      );
    const settings = agents.settings("pi");

    usage = {
      status: "balance",
      provider: "DeepSeek",
      available: true,
      balances: [{ currency: "CNY", amount: 0 }],
    };
    await agents.refreshRuntime("pi");
    const hired = await hire();
    expect(hired).toMatch(/余额用完了/u);

    usage = null;
    agents.spend("pi", 1.2);
    await agents.updateRuntime("pi", { ...settings, dailyBudget: 1 });
    const hired2 = await hire();
    expect(hired2).toMatch(/每日预算 ¥1\.00/u);

    // A window used up would only fail with a quota error.
    const resets = new Date(2026, 9, 14, 8, 0).getTime();
    usage = {
      status: "ok",
      subscription: "pro",
      windows: [
        { label: "5h", usedPercent: 40, resetsAt: null },
        { label: "Codex · 1 week", usedPercent: 100, resetsAt: resets },
      ],
    };
    await agents.updateRuntime("pi", settings);
    const hired3 = await hire();
    expect(hired3).toMatch(/额度用完了（Codex · 1 week），10 月 14 日 08:00重置/u);

    usage = {
      status: "ok",
      subscription: "pro",
      windows: [{ label: "Codex · 1 week", usedPercent: 99, resetsAt: resets }],
    };
    await agents.refreshRuntime("pi");
    const hired4 = await hire();
    expect(hired4).toBe("");
  });
});
