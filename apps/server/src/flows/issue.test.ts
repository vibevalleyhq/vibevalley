import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, isBusy, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Channel } from "@/channel/channel.ts";
import { Core } from "@/core/core.ts";
import { Cron } from "@/cron/cron.ts";
import { viewOf } from "@/game/view.ts";
import { Issue } from "@/issue/issue.ts";
import { openFindings } from "@/issue/status.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { Runtime } from "@/runtime/runtime.ts";
import { Session } from "@/session/session.ts";
import { write } from "@/testing/git.ts";
import { helper } from "@/testing/worker.ts";
import { Said, testIssues } from "@/testing/world.ts";

import { await_, farm, git, lab, mustHire, until, watch } from "./farm.ts";

const refusedWith = (e: unknown, words = "") => {
  const tagged = e as { _tag?: string; reason?: string };
  expect(tagged._tag).toBe("Refused");
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
  // Done is the owner's verdict; what it delivers follows the issue: nothing to take in touches no git, a branch can be
  // kept unmerged, and only commits go into the main branch.
  it.live("completes by what it delivers: nothing, a kept branch, or a merge", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const project = join(f.config.workRoot, "projects", "clock");
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
      const mainLog = () => git(project, "log", "--format=%s", "main");

      const looked = mustHire(yield* issues.hire(lab(), "看看打卡页", "clock"));
      yield* w.nextReport;
      const before = mainLog();
      yield* issues.setStatus(looked.issue!, "done", "", "", owner);
      const nothing = yield* closed(looked.issue!);
      expect([nothing.status, nothing.delivered, nothing.canceled]).toEqual(["done", "none", undefined]);
      const gone = yield* left(looked.id);
      expect(gone?.phase._tag === "closed" && gone.phase.closed).toBe("completed");
      expect(mainLog()).toBe(before);

      const kept = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const keptIssue = yield* issues.get(kept.issue!);
      yield* issues.edit(kept.issue!, { deliver: "branch" }, owner);
      yield* issues.setStatus(kept.issue!, "done", "", "", owner);
      expect((yield* closed(kept.issue!)).delivered).toBe("kept");
      yield* left(kept.id);
      expect(mainLog()).toBe(before);
      expect(git(project, "branch", "--list", `vibevalley/issue-${keptIssue.number}`)).not.toBe("");

      const completed = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      yield* issues.setStatus(completed.issue!, "done", "", "", owner);
      expect((yield* closed(completed.issue!)).delivered).toBe("merged");
      expect(mainLog()).not.toBe(before);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("closes and reopens", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Agent).save(lab());
      const session = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock-in"));
      expect(session.issue).toBeTruthy();
      yield* w.nextReport;
      refusedWith(yield* Effect.flip(issues.setStatus(session.id, "todo", "", "", owner)));
      yield* issues.setStatus(session.issue!, "done", "", "", owner);
      const ended = (yield* sessions.get(session.id))!;
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
      yield* closedAs("merged");

      const again = latest(yield* issues.setStatus(session.id, "todo", "打卡还要记下时区", "", owner));
      yield* w.nextReport;
      const issue = yield* issues.get(again);
      expect([issue.id, sessionIdsOf(issue), issue.delivered, issue.canceled, issue.closedAt]).toEqual([
        session.issue,
        [session.id, again],
        undefined,
        undefined,
        undefined,
      ]);
      const reopened = (yield* sessions.get(again))!;
      expect(reopened.brief).toMatch(new RegExp(`^打卡还要记下时区\\n\\n（这张工单重开了，上一次是 .+（${session.id}）做的。）`, "u"));
      expect(reopened.brief).toMatch(/这张工单原来是：写打卡并提交\n它是怎么关的：已完成，合进了主分支/u);
      refusedWith(yield* Effect.flip(issues.setStatus(session.issue!, "todo", "", "", owner)));
      expect((yield* Effect.flip(issues.setStatus("w404", "todo", "", "", owner)))._tag).toBe("Missing");
      yield* sessions.dismiss(again);
      yield* closedAs("dismissed");
      yield* sql`update issue set delivered = 'merged_into_parent', canceled = null, closed_at = ${Date.now()} where id = ${issue.id}`.pipe(Effect.orDie);
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "todo", "", "", owner)), "计划里的工单");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("reopens an issue run in the profile's own folder, which has no project and so no branch", () => {
    const f = farm({ repos: ["board"] });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const me = { ...lab(), workdir: "board" };
      yield* (yield* Agent).save(me);
      const issue = yield* issues.add({ title: "看看", agent: me.id });
      yield* issues.setStatus(issue.id, "todo", "", "", owner);
      yield* w.nextReport;
      expect((yield* issues.get(issue.id)).project ?? "").toBe("");
      yield* issues.setStatus(issue.id, "canceled", "", "", owner);
      const again = yield* Effect.result(issues.setStatus(issue.id, "todo", "再看看", "", owner));
      expect(again._tag).toBe("Success");
      yield* w.nextReport;
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("written down is started, edited, and ordered", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      refusedWith(yield* Effect.flip(issues.add({ title: "  " })));
      let issue = yield* issues.add({ title: "写打卡并提交" });
      expect(issue.status).toBe("backlog");
      const inState = (id: string) => core.state().issues.find((x) => x.id === id);
      expect(inState(issue.id)?.title).toBe("写打卡并提交");
      refusedWith(yield* Effect.flip(issues.start(issue.id, "")));
      issue = yield* issues.edit(issue.id, { project: "backlog", agent: "lab" }, owner);
      expect([issue.project, assignedAgentOf(issue)]).toEqual(["backlog", "lab"]);
      const got = yield* issues.start(issue.id, "");
      expect(got.session).toBeDefined();
      yield* w.nextReport;
      expect((yield* sessions.get(got.session!))!.brief).toBe("写打卡并提交");
      const started = yield* issues.get(issue.id);
      expect([sessionIdsOf(started), started.status]).toEqual([[got.session], "in_review"]);
      yield* until(() => {
        const current = inState(issue.id);
        return current !== undefined && executionsOf(current).length === 1 && current.status === "in_review";
      }, "the core state follows its run");
      refusedWith(yield* Effect.flip(issues.start(issue.id, "")));
      refusedWith(yield* Effect.flip(issues.edit(issue.id, { title: "改不了了" }, owner)));

      const unsent = (all: T.Issue[]) => all.filter((i) => executionsOf(i).length === 0).map((i) => i.title);
      const a = yield* issues.add({ title: "一" });
      const b = yield* issues.add({ title: "二", priority: "urgent" });
      const c = yield* issues.add({ title: "三" });
      expect([a.priority, b.priority]).toEqual(["medium", "urgent"]);
      yield* issues.edit(c.id, { before: a.id }, owner);
      expect(unsent(yield* issues.list())).toEqual(["三", "一", "二"]);
      yield* issues.edit(c.id, { before: "" }, owner);
      expect(unsent(yield* issues.list())).toEqual(["一", "二", "三"]);
      const d = yield* issues.add({ title: "四" });
      const all = yield* issues.list();
      expect(unsent(all)[3]).toBe(d.title);
      expect(all.at(-1)!.id).toBe(issue.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("waits for room", () => {
    const f = farm({ change: (c) => ({ ...c, project: { ...c.project, maxSessions: 1 } }) });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      yield* core.apply({
        type: "session",
        session: {
          id: "w90",
          role: "worker",
          name: "占地的",
          agent: "lab",
          runtime: "pi",
          brief: "先干着",
          project: "queue",
          hiredAt: 0,
          runs: 0,
          phase: { _tag: "working", since: Date.now(), doing: { action: "none", label: "" } },
          refining: false,
        } as T.Session,
      });
      const issue = yield* issues.add({ title: "等空位的活", project: "queue", agent: "lab" });
      const got = yield* issues.start(issue.id, "");
      expect(got.session).toBeUndefined();
      expect(got.queued).toContain("排上队了");
      const status = () => Effect.map(issues.get(issue.id), (i) => i.status);
      expect(yield* status()).toBe("todo");
      yield* (yield* Issue).refreshQueue;
      expect(yield* status()).toBe("todo");
      const other = yield* issues.add({ title: "别排了", project: "queue", agent: "lab" });
      const queued = yield* issues.setStatus(other.id, "todo", "", "", owner);
      const unqueued = yield* issues.setStatus(other.id, "backlog", "", "", owner);
      expect([queued.queuedAt !== undefined, unqueued.queuedAt]).toEqual([true, undefined]);
      yield* core.apply({ type: "sessionGone", id: sessionId("w90") });
      yield* (yield* Issue).refreshQueue;
      yield* w.nextReport;
      expect(yield* status()).toBe("in_review");
      expect((yield* sessions.list("lab")).some((s) => s.brief === "等空位的活")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("regression: cron inputs wait for human review and reopen the same completed issue", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const crons = yield* Cron;
      yield* (yield* Agent).save({ ...lab(), enabled: true });
      const made = yield* crons.add(
        {
          name: "巡检",
          text: "看一眼",
          agent: "lab",
          project: "every",
          when: { kind: "every", minutes: 5 },
        },
        owner,
      );
      const mailbox = yield* Mailbox;
      const due = () => Effect.andThen(TestClock.adjust(5 * 60_000 + 1), crons.tick).pipe(Effect.andThen(mailbox.replay));
      const ofCron = () => Effect.map(issues.list(), (all) => withCron(all, made.id));
      const runs = () => Effect.flatMap(ofCron(), (i) => sessions.issueRuns(i.id));
      yield* due();
      yield* w.nextReport;
      const first = yield* ofCron();
      expect(sessionIdsOf(first)).toHaveLength(1);
      expect(f.turns[0]!.input).toContain("vv://trigger/");

      yield* due();
      expect((yield* ofCron()).id).toBe(first.id);
      expect(sessionIdsOf(yield* ofCron())).toHaveLength(1);
      expect(yield* runs()).toHaveLength(1);
      const sql = yield* SqlClient.SqlClient;
      const held = yield* sql
        .unsafe<{ state: string }>("select state from mailbox_issue where issue_id = $1 and state = 'held'", [first.id])
        .pipe(Effect.orDie);
      expect(held).toHaveLength(1);

      yield* issues.setStatus(first.id, "done", "", "", owner);
      yield* await_(ofCron, (i) => i.status === "done", "merged");
      yield* due();
      yield* w.nextReport;
      expect((yield* ofCron()).id).toBe(first.id);
      expect(sessionIdsOf(yield* ofCron())).toHaveLength(2);
      const two = yield* await_(runs, (r) => r.length === 2, "a second run");
      expect(two[1]!.triggeredBy.kind).toBe("cron");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("update changes only what it gives", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      let issue = yield* issues.add({
        title: "写打卡",
        description: "每天一次",
        project: "demo",
        agent: "lab",
        priority: "high",
      });
      issue = yield* issues.edit(issue.id, { title: "写打卡并提交" }, owner);
      expect([issue.title, issue.description, issue.project, assignedAgentOf(issue), issue.priority]).toEqual([
        "写打卡并提交",
        "每天一次",
        "demo",
        "lab",
        "high",
      ]);
      issue = yield* issues.edit(issue.id, { project: "" }, owner);
      expect([issue.project, assignedAgentOf(issue)]).toEqual([undefined, "lab"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // The owner only moves the issue: todo sends it out, todo again is another round, done merges; the dropped one comes back.
  it.live("is worked by moving it", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      yield* (yield* Agent).save(lab());
      const move = (id: string, to: T.Issue["status"], text = "") => issues.setStatus(id, to, text, "", owner);
      let issue = yield* issues.add({ title: "写打卡并提交", project: "clock", agent: "lab" });
      expect(issue.moves).toEqual(["todo", "canceled"]);
      refusedWith(yield* Effect.flip(move(issue.id, "in_progress")));
      issue = yield* move(issue.id, "todo");
      yield* w.nextReport;
      issue = yield* issues.get(issue.id);
      expect([issue.status, issue.moves]).toEqual(["in_review", ["todo", "done", "canceled"]]);
      refusedWith(yield* Effect.flip(move(issue.id, "todo", " ")));
      yield* move(issue.id, "todo", "再写版本B");
      yield* w.nextReport;
      issue = yield* move(issue.id, "done");
      expect(issue.status).toBe("done");
      expect(git(join(f.config.workRoot, "projects", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/u);
      expect(issue.moves).toEqual(["todo"]);

      let dropped = yield* issues.add({ title: "算了" });
      dropped = yield* move(dropped.id, "canceled");
      expect([dropped.status, dropped.canceled]).toEqual(["canceled", "dismissed"]);
      dropped = yield* move(dropped.id, "backlog");
      expect(dropped.status).toBe("backlog");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("moved to done is refused when the project's check fails", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const helper = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const cwd = sessions.cwdOf(helper.id)!;
      mkdirSync(join(cwd, ".vibevalley"), { recursive: true });
      write(join(cwd, ".vibevalley/check"), "#!/bin/sh\necho merge-check-failed\nexit 1\n", 0o755);
      const project = join(f.config.workRoot, "projects", "clock");
      const before = git(project, "rev-parse", "main");
      refusedWith(yield* Effect.flip(issues.setStatus(helper.issue!, "done", "", "", owner)), "merge-check-failed");
      // Not done; the helper is already told what failed (issue/merge.ts notTaken) and may be at it (in_progress).
      expect((yield* issues.get(helper.issue!)).status).not.toBe("done");
      yield* until(() => {
        const got = sessions.sessionOf(helper.id);
        return got !== undefined && sessions.lastTextOf(helper.id).includes("merge-check-failed") && !isBusy(got);
      }, "the helper hears the check's output");
      expect((yield* issues.get(helper.issue!)).status).toBe("in_review");
      expect(git(project, "rev-parse", "main")).toBe(before);
      expect(existsSync(cwd)).toBe(true);
      git(project, "rev-parse", "--verify", helper.branch!);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("keeps its worktree when cancelled and reopened", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({
        title: "写打卡并提交",
        project: "resume",
        agent: "lab",
      });
      const sent = yield* issues.start(issue.id, "");
      yield* w.nextReport;
      const first = (yield* sessions.get(sent.session!))!;
      expect(first.branch).toBe(`vibevalley/issue-${issue.number}`);
      const before = git(first.worktree!, "rev-parse", "HEAD");
      yield* sessions.dismiss(first.id);
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.closedAt !== undefined,
        "cancelled",
      );
      let again = latest(yield* issues.setStatus(issue.id, "todo", "接着做", "", owner));
      yield* w.nextReport;
      const reopened = (yield* sessions.get(again))!;
      expect([reopened.branch, reopened.worktree]).toEqual([first.branch, first.worktree]);
      expect(git(reopened.worktree!, "rev-parse", "HEAD")).toBe(before);
      expect(reopened.brief).toContain("这条分支上已经有上次的提交，接着做。");
      yield* issues.setStatus(issue.id, "done", "", "", owner);
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.delivered === "merged",
        "merged",
      );
      again = latest(yield* issues.setStatus(issue.id, "todo", "再看看", "", owner));
      yield* w.nextReport;
      expect((yield* sessions.get(again))!.brief).not.toContain("这条分支上已经有上次的提交，接着做。");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("moves as the issue's buttons say", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const { in: saidIn } = yield* Said;
      const chat = yield* Channel;
      yield* (yield* Agent).save(lab());
      const drop = yield* issues.add({ title: "先放着", project: "acts", agent: "lab" });
      const dropped = yield* issues.setStatus(drop.id, "canceled", "", "", owner);
      expect([dropped.status, dropped.stage.acts]).toEqual(["canceled", [{ act: "reopen", does: "move", status: "backlog", words: "none" }]]);
      // Never sent: a reopen is back to the backlog, with nothing to tell.
      expect((yield* issues.setStatus("#" + drop.number, "backlog", "", "", owner)).status).toBe("backlog");

      const issue = yield* issues.add({ title: "这一单必败", project: "acts", agent: "lab" });
      yield* issues.setStatus(issue.id, "todo", "", "", owner);
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.stage.stuck === "failed",
        "stuck: failed",
      );
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "done", "", "", owner)), "这一轮没做成");
      expect((yield* issues.get(issue.id)).stage.acts[0]).toEqual({ act: "cure", does: "move", status: "todo", words: "none" });
      yield* issues.setStatus(issue.id, "todo", "", "", owner);
      const running = latestSessionIdOf(yield* issues.get(issue.id));
      if (running === undefined) throw new Error("the issue has no execution session");
      const thread = (yield* chat.threadOfSession(running))!;
      yield* until(
        () => saidIn(thread).some((m) => m.from === "owner" && m.text === "接着修：这一单必败。看一下报错，修好再跑一遍测试"),
        "the cure said once, by the server",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: a dry run reads an unsaved agent through an Assignment", () => {
    const f = farm();
    return Effect.gen(function* () {
      const issues = testIssues(yield* Issue);
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "先选人再开工" });
      const preview = yield* issues.previewStatus(issue.id, "todo", "", {}, { agent: "lab" });
      expect(preview.does.join("\n")).toContain(lab().name);
      expect((yield* issues.get(issue.id)).assignments).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A dry run of a move says what it would do, from the same judgment as the move, and changes nothing: no git, no status.
  it.live("says what completing would deliver before it is done, and then does that", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      yield* (yield* Agent).save(lab());
      const project = join(f.config.workRoot, "projects", "clock");
      const committed = mustHire(yield* issues.hire(lab(), "写打卡并提交", "clock"));
      yield* w.nextReport;
      const before = git(project, "log", "--format=%s", "main");
      const merging = yield* issues.previewStatus(committed.issue!, "done", "");
      expect(merging.does.at(-1)).toMatch(/^合进 main（1 个提交），关成已完成，/u);
      const keeping = yield* issues.previewStatus(committed.issue!, "done", "", {}, { deliver: "branch" });
      expect(keeping.does[0]).toMatch(/关成已完成：分支留着没合（1 个提交）$/u);
      expect([git(project, "log", "--format=%s", "main"), (yield* issues.get(committed.issue!)).status]).toEqual([before, "in_review"]);
      yield* issues.setStatus(committed.issue!, "done", "", "", owner);
      const done = yield* await_(
        () => issues.get(committed.issue!),
        (i) => i.closedAt !== undefined,
        "done",
      );
      expect(done.delivered).toBe("merged");

      const looked = mustHire(yield* issues.hire(lab(), "看看打卡页", "clock"));
      yield* w.nextReport;
      expect((yield* issues.previewStatus(looked.issue!, "done", "")).does[0]).toMatch(/关成已完成：没有改动要合$/u);
      expect((yield* issues.previewStatus(looked.issue!, "canceled", "")).does[0]).toMatch(/关成已取消$/u);
      refusedWith(yield* Effect.flip(issues.previewStatus(looked.issue!, "todo", "")), "要说一句");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // An answer issue is read only: its conclusion is read into the issue, whatever the round changed goes, and completing it
  // delivers nothing. An answer that cannot be read is a round not done: 接着修 says what was wrong with it.
  it.live("answers with a conclusion and leaves nothing on its branch", () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const turns: NonNullable<Parameters<typeof helper>[0]> = [];
    const f = farm({ runtime: helper(turns, async (_turn, _input, n) => gates[n]?.promise ?? Promise.resolve()) });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const sessions = yield* Session;
      const { in: saidIn } = yield* Said;
      const chat = yield* Channel;
      yield* (yield* Agent).save(lab());
      const project = join(f.config.workRoot, "projects", "clock");
      const asked = yield* issues.add({
        title: "查一下打卡为什么慢，顺手提交",
        project: "clock",
        agent: "lab",
        deliver: "answer",
      });
      expect(asked.deliver).toBe("answer");
      yield* issues.setStatus(asked.id, "todo", "", "", owner);
      yield* until(() => turns.length >= 1, "the answer run");
      const firstSession = latestSessionIdOf(yield* issues.get(asked.id))!;
      yield* sessions.report(firstSession, {
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
      yield* w.nextReport;
      const answered = yield* await_(
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
      yield* until(() => git(project, "rev-parse", branch) === git(project, "rev-parse", "main"), "what it committed gone");
      yield* issues.setStatus(asked.id, "done", "", "", owner);
      const done = yield* await_(
        () => issues.get(asked.id),
        (i) => i.closedAt !== undefined,
        "done",
      );
      expect([done.status, done.delivered, done.answer?.conclusion]).toEqual(["done", "none", "打卡慢是因为每次都重读配置"]);

      const garbled = yield* issues.add({
        title: "查一下 乱写",
        project: "clock",
        agent: "lab",
        deliver: "answer",
      });
      yield* issues.setStatus(garbled.id, "todo", "", "", owner);
      yield* until(() => turns.length >= 2, "the unstructured answer run");
      gates[1]!.resolve();
      yield* w.nextReport;
      const stuck = yield* await_(
        () => issues.get(garbled.id),
        (i) => i.stage.stuck === "failed",
        "stuck: no answer read",
      );
      expect([stuck.answer, stuck.moves]).toEqual([undefined, ["todo", "canceled"]]);
      refusedWith(yield* Effect.flip(issues.setStatus(garbled.id, "done", "", "", owner)), "这一轮没做成");
      yield* issues.setStatus(garbled.id, "todo", "", "", owner);
      const running = latestSessionIdOf(stuck);
      if (running === undefined) throw new Error("the issue has no execution session");
      const thread = (yield* chat.threadOfSession(running))!;
      yield* until(
        () => saidIn(thread).some((m) => m.from === "owner" && m.text.startsWith("接着修：上一轮交回的结论读不出来（没有通过 issue_report")),
        "what was wrong with it, said",
      );
      yield* until(() => turns.length >= 3, "the corrected answer run");
      yield* sessions.report(running, {
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
      yield* w.nextReport;
      yield* await_(
        () => issues.get(garbled.id),
        (i) => i.answer !== undefined && i.stage.state === "reviewing",
        "answered the second time",
      );
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // Done is what was asked for, not how a round ended: a round that failed is not completed, whoever asks.
  it.live("does not complete a round that failed", () => {
    const f = farm();
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      yield* (yield* Agent).save(lab());
      const issue = yield* issues.add({ title: "这一单必败", project: "fails", agent: "lab" });
      yield* issues.setStatus(issue.id, "todo", "", "", owner);
      yield* w.nextReport;
      const failed = yield* await_(
        () => issues.get(issue.id),
        (i) => i.stage.stuck === "failed",
        "stuck: failed",
      );
      expect(failed.status).toBe("in_review");
      expect(failed.moves).toEqual(["todo", "canceled"]);
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "done", "", "", owner)), "这一轮没做成");
      refusedWith(yield* Effect.flip(issues.setStatus(issue.id, "done", "", "", owner)), "这一轮没做成");
      expect((yield* issues.get(issue.id)).closedAt).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  // A question in a report leaves the plot short of fertilizer until the owner answers.
  it.live("grows through its acceptance", () => {
    const first = Promise.withResolvers<void>();
    const turns: NonNullable<Parameters<typeof helper>[0]> = [];
    const f = farm({ runtime: helper(turns, async (_turn, _input, n) => (n === 0 ? first.promise : Promise.resolve())) });
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = testIssues(yield* Issue);
      const core = yield* Core;
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      let issue = yield* issues.add({
        title: "先问清楚，再写打卡并提交",
        project: "clock",
        agent: "lab",
      });
      yield* issues.setStatus(issue.id, "todo", "", "", owner);
      yield* until(() => turns.length >= 1, "the asking run");
      const firstSession = latestSessionIdOf(yield* issues.get(issue.id))!;
      yield* sessions.report(firstSession, {
        summary: "需要端口",
        questions: [{ question: "用 8787 还是 8797？", options: [] }],
        checks: [],
        remember: [],
        prSubmit: false,
      });
      first.resolve();
      yield* w.nextReport;
      issue = yield* await_(
        () => issues.get(issue.id),
        (i) => i.questions.length === 1,
        "its question kept",
      );
      expect(issue.questions).toEqual([{ question: "用 8787 还是 8797？", options: [] }]);
      const crop = () => viewOf(core.state()).plots[issue.id]?.crop;
      yield* until(() => crop() === "dry", "the plot waiting on an answer");

      yield* issues.comment(issue.id, "用 8797");
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.questions.length === 0,
        "answered",
      );
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.status === "in_review",
        "handed back",
      );
      yield* until(() => crop() === "flowering", "抽穗：等验收");

      yield* issues.setStatus(issue.id, "todo", "再写版本B", "", owner);
      expect(openFindings(yield* issues.get(issue.id))).toBe(1);
      yield* w.nextReport;
      yield* await_(
        () => issues.get(issue.id),
        (i) => i.status === "in_review",
        "the weed worked on and handed back",
      );
      // Handed back again it waits on the owner's acceptance, as its page says; the findings stay open until a pass.
      yield* until(() => crop() === "flowering", "waiting on the acceptance again");
      expect(openFindings(yield* issues.get(issue.id))).toBe(1);

      issue = yield* issues.setStatus(issue.id, "done", "", "", owner);
      expect([issue.status, openFindings(issue)]).toEqual(["done", 0]);
      expect(git(join(f.config.workRoot, "projects", "clock"), "log", "--format=%s", "main")).toMatch(/版本 B/u);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is not sent when the money runs out", () => {
    let usage: T.AccountUsage | null = null;
    const f = farm({ usage: () => usage });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const runtimes = yield* Runtime;
      const agents = yield* Agent;
      const hire = () => Effect.map(issues.hire(lab(), "随便做点什么", "money"), (h) => h.refused ?? "");
      const settings = agents.settings("pi");

      usage = {
        status: "balance",
        provider: "DeepSeek",
        available: true,
        balances: [{ currency: "CNY", amount: 0 }],
      };
      yield* runtimes.refresh("pi");
      expect(yield* hire()).toMatch(/余额用完了/u);

      usage = null;
      runtimes.spend("pi", 1.2);
      yield* runtimes.update("pi", { ...settings, dailyBudget: 1 });
      expect(yield* hire()).toMatch(/每日预算 ¥1\.00/u);

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
      yield* runtimes.update("pi", settings);
      expect(yield* hire()).toMatch(/额度用完了（Codex · 1 week），10 月 14 日 08:00重置/u);

      usage = {
        status: "ok",
        subscription: "pro",
        windows: [{ label: "Codex · 1 week", usedPercent: 99, resetsAt: resets }],
      };
      yield* runtimes.refresh("pi");
      expect(yield* hire()).toBe("");
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
